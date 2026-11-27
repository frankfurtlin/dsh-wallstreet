/**
 * dsh-wallstreet —— client 半（浏览器）。
 *
 * 手写 ModuleLoader 工厂，不经打包：只依赖宿主已提供的 react，用 h() 直接构造
 * 元素。做两件事：
 *   1. 在侧栏「插件」组的 panellist 座位注册一行「华尔街之狼」（order 5，排在
 *      知识库(3) 之后，创作台(6) / Automation tasks(10) 之前）。
 *   2. 在 main 座位注册 keyed 面板页：直接渲染市场概览仪表盘（不走 iframe），
 *      数据来自宿主同源 API `/wallstreet/api/*`，因此自动继承 DSH 登录态。
 *
 * 一期范围：A 股/港股/美股指数、上证分时、市场宽度、两市成交额、行业板块轮动、
 * 上证 60 日日K（蜡烛）与均线、市场温度与文字解读。所有数值与结论都由宿主算好，
 * 前端只负责呈现；每 30s 轮询一次（页面隐藏时暂停）。
 */
window.__ModuleLoader__.load({
  id: "dsh-wallstreet",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;

    /** 侧栏行 id —— 同时是 main 座位的 key 与图标上的 data 锚点。 */
    var PANEL_ID = "wallstreet";
    /** 侧栏顺序：插件 = 0，知识库 = 3，华尔街之狼 = 5，创作台 = 6，Automation tasks = 10，酒馆 = 12，紫微斗数 = 14。 */
    var PANEL_ORDER = 5;
    /** 宿主数据 API：同源，浏览器自动带 DSH 会话。 */
    var API = "/wallstreet/api";
    /** 轮询间隔：盘中 30s；数据在宿主侧已有 15–60s 缓存，不会打爆上游。 */
    var POLL_MS = 30000;

    var COLORS = {
      border: "color-mix(in srgb, currentColor 16%, transparent)",
      borderStrong: "color-mix(in srgb, currentColor 26%, transparent)",
      muted: "color-mix(in srgb, currentColor 58%, transparent)",
      faint: "color-mix(in srgb, currentColor 40%, transparent)",
      chip: "color-mix(in srgb, currentColor 8%, transparent)",
      up: "#d64545",
      down: "#2f9e6b",
    };

    // 数值统一用等宽字体：表格和卡片里的数字列宽稳定，不随数值跳动。
    var NUM_FONT = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

    /** 容器宽度（ResizeObserver）：用于面板内布局的响应式断点。 */
    function useElementWidth(ref) {
      var state = react.useState(0);
      var width = state[0];
      var setWidth = state[1];
      react.useEffect(
        function () {
          var node = ref.current;
          if (!node) return undefined;
          if (typeof ResizeObserver === "function") {
            var observer = new ResizeObserver(function (entries) {
              var entry = entries[0];
              var next = entry && entry.contentRect ? entry.contentRect.width : node.clientWidth;
              setWidth(Math.round(next));
            });
            observer.observe(node);
            setWidth(Math.round(node.clientWidth));
            return function () {
              observer.disconnect();
            };
          }
          var onResize = function () {
            setWidth(Math.round(node.clientWidth));
          };
          window.addEventListener("resize", onResize);
          onResize();
          return function () {
            window.removeEventListener("resize", onResize);
          };
        },
        [ref],
      );
      return width;
    }

    /** 视口级媒体查询：用于判断 DSH 外壳是否收起了侧栏（此时左上角有浮动按钮）。 */
    function useMediaQuery(query) {
      var state = react.useState(function () {
        try {
          return window.matchMedia(query).matches;
        } catch (error) {
          return false;
        }
      });
      var matches = state[0];
      var setMatches = state[1];
      react.useEffect(
        function () {
          var mql;
          try {
            mql = window.matchMedia(query);
          } catch (error) {
            return undefined;
          }
          var onChange = function (event) {
            setMatches(event.matches);
          };
          setMatches(mql.matches);
          if (typeof mql.addEventListener === "function") mql.addEventListener("change", onChange);
          else if (typeof mql.addListener === "function") mql.addListener(onChange);
          return function () {
            if (typeof mql.removeEventListener === "function") mql.removeEventListener("change", onChange);
            else if (typeof mql.removeListener === "function") mql.removeListener(onChange);
          };
        },
        [query],
      );
      return matches;
    }

    /** 侧栏图标：向上的折线 + 星（华尔街的「行情 + 野心」）。 */
    function WallstreetPanelIcon(props) {      var size = (props && props.size) || 16;
      return h(
        "svg",
        {
          "data-dsh-panel-entry": PANEL_ID,
          viewBox: "0 0 16 16",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.3",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("path", { d: "M2 12.4 L5.4 9 L8 10.8 L11 6.6 L14 8.2" }),
        h("path", { d: "M11.4 2.2 L12.1 3.7 L13.7 4.4 L12.1 5.1 L11.4 6.6 L10.7 5.1 L9.1 4.4 L10.7 3.7 Z" }),
      );
    }

    /* ------------------------------ 格式化工具 ------------------------------ */

    function isNum(value) {
      return typeof value === "number" && Number.isFinite(value);
    }

    function pctText(value) {
      if (!isNum(value)) return "—";
      return (value > 0 ? "+" : "") + value.toFixed(2) + "%";
    }

    function priceText(value) {
      if (!isNum(value)) return "—";
      var abs = Math.abs(value);
      var digits = abs >= 10000 ? 0 : abs >= 1000 ? 1 : 2;
      return value.toFixed(digits);
    }

    function pointText(value) {
      if (!isNum(value)) return "—";
      return (value > 0 ? "+" : "") + value.toFixed(2);
    }

    /** 元 → 亿元，保留 1 位小数。 */
    function yi(value) {
      if (!isNum(value)) return "—";
      return (value / 1e8).toFixed(1) + " 亿";
    }

    function signedYi(value) {
      if (!isNum(value)) return "—";
      return (value > 0 ? "+" : "") + (value / 1e8).toFixed(1) + " 亿";
    }

    function timeText(iso) {
      if (!iso) return "—";
      var date = new Date(iso);
      if (!Number.isFinite(date.getTime())) return "—";
      return date.toLocaleTimeString("zh-CN", { hour12: false });
    }

    function toneColor(tone) {
      if (tone === "hot") return COLORS.up;
      if (tone === "warm") return "#d98b3f";
      if (tone === "cool") return "#4a8fc7";
      if (tone === "cold") return COLORS.down;
      return COLORS.muted;
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    /* ------------------------------ 小型组件 ------------------------------ */

    function SectionCard(props) {
      return h(
        "section",
        {
          "data-wallstreet-card": props.id || "",
          style: {
            border: "1px solid " + COLORS.border,
            borderRadius: 12,
            background: "color-mix(in srgb, currentColor 2.5%, transparent)",
            padding: "14px 16px",
            minWidth: 0,
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 } },
          h("h3", { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, props.title),
          props.hint
            ? h("span", { style: { fontSize: 11.5, color: COLORS.muted } }, props.hint)
            : null,
          h("span", { style: { flex: 1 } }),
          props.extra || null,
        ),
        props.children,
      );
    }

    function Tag(props) {
      return h(
        "span",
        {
          style: {
            display: "inline-block",
            padding: "1px 8px",
            borderRadius: 999,
            fontSize: 11.5,
            background: COLORS.chip,
            color: props.color || COLORS.muted,
            whiteSpace: "nowrap",
          },
        },
        props.children,
      );
    }

    function EmptyHint(props) {
      return h(
        "div",
        { style: { fontSize: 12.5, color: COLORS.muted, padding: "10px 0" } },
        props.children || "暂无数据",
      );
    }

    /** 盘面一句话结论：量能 + 涨跌 + 情绪压成一句，放在盘面顶部。 */
    function BriefingBar(props) {
      var summary = props.summary;
      if (!summary || !summary.text) return null;
      var tone = summary.tone;
      var color = tone === "up" ? COLORS.up : tone === "down" ? COLORS.down : COLORS.muted;
      return h(
        "div",
        {
          "data-wallstreet-summary": "",
          style: {
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: "9px 12px",
            border: "1px solid " + COLORS.border,
            borderLeft: "3px solid " + color,
            borderRadius: 9,
            background: "color-mix(in srgb, currentColor 2.5%, transparent)",
            fontSize: 12.5,
            lineHeight: 1.65,
          },
        },
        h("span", {
          style: { width: 6, height: 6, borderRadius: 3, background: color, marginTop: 8, flexShrink: 0 },
        }),
        h("span", { style: { flex: 1, minWidth: 0 } }, summary.text),
        props.stale && !props.live ? h(Tag, null, "快照 T-1") : null,
      );
    }

    /* ------------------------------ 图表 ------------------------------ */

    /** 迷你走势线：只画价格轨迹，不加坐标轴。 */
    function Sparkline(props) {
      var values = props.values || [];
      if (values.length < 2) {
        return h("div", { style: { height: props.height || 32 } });
      }
      var width = 120;
      var height = props.height || 32;
      var min = Math.min.apply(null, values);
      var max = Math.max.apply(null, values);
      var span = max - min || 1;
      var stepX = width / (values.length - 1);
      var points = values.map(function (value, index) {
        var x = index * stepX;
        var y = height - 3 - ((value - min) / span) * (height - 6);
        return x.toFixed(1) + "," + y.toFixed(1);
      });
      var stroke = values[values.length - 1] >= values[0] ? COLORS.up : COLORS.down;
      return h(
        "svg",
        {
          viewBox: "0 0 " + width + " " + height,
          width: "100%",
          height: height,
          preserveAspectRatio: "none",
          "aria-hidden": "true",
        },
        h("polyline", {
          points: points.join(" "),
          fill: "none",
          stroke: stroke,
          strokeWidth: "1.4",
          strokeLinejoin: "round",
          strokeLinecap: "round",
        }),
      );
    }

    /** 上证分时：价格折线 + 均价线 + 昨收基准 + 涨跌幅 Y 轴 + hover 十字线。 */
    function TrendChart(props) {
      var points = (props.trend && props.trend.points) || [];
      var preClose = props.trend ? props.trend.preClose : null;
      if (points.length < 2) return h(EmptyHint, null, "分时数据暂不可用");

      var hoverState = react.useState(null);
      var hover = hoverState[0];
      var setHover = hoverState[1];

      var width = 820;
      var height = 240;
      var padTop = 12;
      var padBottom = 24;
      var gutter = 54;
      var padRight = 10;
      var values = [];
      for (var i = 0; i < points.length; i += 1) {
        values.push(points[i].price);
        if (isNum(points[i].average)) values.push(points[i].average);
      }
      if (isNum(preClose)) values.push(preClose);
      var dataMin = Math.min.apply(null, values);
      var dataMax = Math.max.apply(null, values);
      var base = isNum(preClose) ? preClose : (dataMin + dataMax) / 2;
      // 以昨收为中心对称留白，涨跌幅刻度才有意义（否则线会贴边）。
      var span = Math.max(dataMax - base, base - dataMin, base * 0.004) * 1.12;
      var min = base - span;
      var max = base + span;
      var innerHeight = height - padTop - padBottom;
      var innerWidth = width - gutter - padRight;
      var scaleY = function (value) {
        return padTop + innerHeight - ((value - min) / (max - min)) * innerHeight;
      };
      var scaleX = function (index) {
        return gutter + (index / (points.length - 1)) * innerWidth;
      };

      var maxPct = (span / base) * 100;
      var stepPct = 5;
      var candidates = [0.25, 0.5, 1, 2, 3, 5];
      for (var c = 0; c < candidates.length; c += 1) {
        if (maxPct / candidates[c] <= 3.2) {
          stepPct = candidates[c];
          break;
        }
      }
      var pctTicks = [];
      for (var k = -3; k <= 3; k += 1) {
        var pct = k * stepPct;
        var value = base * (1 + pct / 100);
        if (value < min || value > max) continue;
        pctTicks.push({ pct: pct, value: value });
      }

      var pricePath = "";
      var avgPath = "";
      for (var m = 0; m < points.length; m += 1) {
        var command = m === 0 ? "M" : "L";
        pricePath += command + scaleX(m).toFixed(1) + " " + scaleY(points[m].price).toFixed(1) + " ";
        if (isNum(points[m].average)) {
          avgPath += command + scaleX(m).toFixed(1) + " " + scaleY(points[m].average).toFixed(1) + " ";
        }
      }
      var areaPath = pricePath + "L" + (width - padRight) + " " + (height - padBottom) + " L" + gutter + " " + (height - padBottom) + " Z";
      var lineColor = isNum(preClose) && points[points.length - 1].price >= preClose ? COLORS.up : COLORS.down;
      var ticks = ["09:30", "10:30", "11:30", "14:00", "15:00"];
      var tickIndexes = [];
      for (var t = 0; t < points.length; t += 1) {
        var label = points[t].time;
        if (ticks.indexOf(label) !== -1 && tickIndexes.indexOf(t) === -1) tickIndexes.push(t);
      }

      var onMove = function (event) {
        var rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width) return;
        var ratio = (event.clientX - rect.left) / rect.width;
        var index = Math.round(ratio * (points.length - 1));
        setHover(Math.max(0, Math.min(points.length - 1, index)));
      };
      var hoverPoint = isNum(hover) ? points[hover] : null;
      var hoverPct = hoverPoint && isNum(preClose) ? ((hoverPoint.price - preClose) / preClose) * 100 : null;
      var tooltipLeft = isNum(hover) ? (scaleX(hover) / width) * 100 : 0;
      var tooltipAlign = isNum(hover) ? (hover / (points.length - 1) > 0.78 ? "right" : hover / (points.length - 1) < 0.22 ? "left" : "center") : "center";

      return h(
        "div",
        { "data-wallstreet-trend": "", style: { position: "relative" } },
        h(
          "svg",
          {
            viewBox: "0 0 " + width + " " + height,
            width: "100%",
            height: "auto",
            preserveAspectRatio: "none",
            role: "img",
            "aria-label": "上证指数分时图",
          },
          h("rect", { x: 0, y: 0, width: width, height: height, fill: "transparent" }),
          pctTicks.map(function (item) {
            var y = scaleY(item.value).toFixed(1);
            return h(
              "g",
              { key: "pct-" + item.pct },
              h("line", { x1: gutter, x2: width - padRight, y1: y, y2: y, stroke: COLORS.border, strokeWidth: "1", strokeDasharray: item.pct === 0 ? "4 3" : "2 5" }),
              h(
                "text",
                { x: gutter - 6, y: Number(y) + 4, fill: COLORS.muted, fontSize: "10.5", textAnchor: "end", fontFamily: NUM_FONT },
                (item.pct > 0 ? "+" : "") + item.pct.toFixed(stepPct < 1 ? 2 : 1) + "%",
              ),
            );
          }),
          h("path", { d: areaPath, fill: lineColor, opacity: "0.08", stroke: "none" }),
          isNum(preClose)
            ? h("line", { x1: gutter, y1: scaleY(preClose).toFixed(1), x2: width - padRight, y2: scaleY(preClose).toFixed(1), stroke: COLORS.muted, strokeWidth: "1", strokeDasharray: "4 4" })
            : null,
          avgPath ? h("path", { d: avgPath, fill: "none", stroke: "#c9a227", strokeWidth: "1.2" }) : null,
          h("path", { d: pricePath, fill: "none", stroke: lineColor, strokeWidth: "1.6", strokeLinejoin: "round", strokeLinecap: "round" }),
          h("line", { x1: gutter, y1: height - padBottom, x2: width - padRight, y2: height - padBottom, stroke: COLORS.border, strokeWidth: "1" }),
          tickIndexes.map(function (index) {
            var tickX = scaleX(index);
            return h(
              "text",
              { key: "tick-" + index, x: tickX.toFixed(1), y: height - 6, fill: COLORS.muted, fontSize: "11", textAnchor: tickX <= gutter + 1 ? "start" : tickX >= width - padRight - 1 ? "end" : "middle" },
              points[index].time,
            );
          }),
          hoverPoint
            ? h(
                "g",
                null,
                h("line", { x1: scaleX(hover), y1: padTop, x2: scaleX(hover), y2: height - padBottom, stroke: COLORS.muted, strokeWidth: "1", strokeDasharray: "3 3" }),
                h("line", { x1: gutter, y1: scaleY(hoverPoint.price), x2: width - padRight, y2: scaleY(hoverPoint.price), stroke: COLORS.muted, strokeWidth: "1", strokeDasharray: "3 3" }),
                h("circle", { cx: scaleX(hover), cy: scaleY(hoverPoint.price), r: 3, fill: "#fff", stroke: lineColor, strokeWidth: "1.6" }),
              )
            : null,
          h("rect", {
            x: gutter,
            y: padTop,
            width: innerWidth,
            height: innerHeight,
            fill: "transparent",
            onMouseMove: onMove,
            onMouseLeave: function () { setHover(null); },
            style: { cursor: "crosshair" },
          }),
        ),
        hoverPoint
          ? h(
              "div",
              {
                "data-wallstreet-trend-tip": "",
                style: {
                  position: "absolute",
                  top: 4,
                  left: tooltipLeft + "%",
                  transform: tooltipAlign === "right" ? "translateX(-100%)" : tooltipAlign === "left" ? "translateX(0)" : "translateX(-50%)",
                  background: "rgba(24, 26, 30, 0.9)",
                  color: "#fff",
                  borderRadius: 6,
                  padding: "4px 8px",
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  pointerEvents: "none",
                  whiteSpace: "nowrap",
                  fontFamily: NUM_FONT,
                },
              },
              hoverPoint.time + "  " + priceText(hoverPoint.price) + "  " + (isNum(hoverPct) ? pctText(hoverPct) : ""),
              isNum(hoverPoint.average) ? "  均价 " + hoverPoint.average.toFixed(2) : "",
            )
          : null,
        h(
          "div",
          { style: { display: "flex", gap: 14, fontSize: 11.5, color: COLORS.muted, marginTop: 4, flexWrap: "wrap" } },
          h("span", null, "— 分时价"),
          h("span", { style: { color: "#c9a227" } }, "— 均价"),
          isNum(preClose) ? h("span", null, "┄ 昨收 " + preClose.toFixed(2)) : null,
          h("span", { style: { flex: 1 } }),
          h("span", null, "最低 " + dataMin.toFixed(2) + " · 最高 " + dataMax.toFixed(2)),
        ),
      );
    }

    /** 近 60 日 K 线（蜡烛 + MA5/MA10/MA20 + 成交量）。 */
    function KlineChart(props) {
      var kline = props.kline || {};
      var recent = kline.recent || [];
      if (recent.length < 2) return h(EmptyHint, null, "日 K 数据暂不可用");

      var width = 820;
      var priceH = 176;
      var volH = 46;
      var gap = 8;
      var padTop = 16;
      var padBottom = 6;
      var padRight = 8;
      var gutter = 58;
      var totalH = priceH + gap + volH;

      var highs = [];
      var lows = [];
      recent.forEach(function (row) {
        highs.push(row.high);
        lows.push(row.low);
      });
      var min = Math.min.apply(null, lows);
      var max = Math.max.apply(null, highs);
      if (!(max > min)) {
        min -= 1;
        max += 1;
      }
      var innerW = width - gutter - padRight;
      var innerH = priceH - padTop - padBottom;
      var scaleY = function (value) {
        return padTop + innerH - ((value - min) / (max - min)) * innerH;
      };
      var step = innerW / recent.length;
      var bodyW = Math.max(2.5, Math.min(9, step * 0.62));
      var xAt = function (index) {
        return gutter + step * (index + 0.5);
      };
      var volMax = 1;
      recent.forEach(function (row) {
        if (row.volume > volMax) volMax = row.volume;
      });
      var volTop = priceH + gap;
      var volY = function (volume) {
        return volTop + volH - (volume / volMax) * (volH - 8);
      };
      var maSeries = kline.maSeries || {};
      var buildMaPath = function (series) {
        var path = "";
        var started = false;
        (series || []).forEach(function (value, index) {
          if (!isNum(value)) return;
          path += (started ? "L" : "M") + xAt(index).toFixed(1) + " " + scaleY(value).toFixed(1) + " ";
          started = true;
        });
        return path;
      };
      var last = recent[recent.length - 1];
      var priceTicks = [];
      for (var t = 0; t <= 2; t += 1) {
        var level = min + ((max - min) * t) / 2;
        priceTicks.push({ value: level, y: scaleY(level) });
      }

      return h(
        "svg",
        {
          viewBox: "0 0 " + width + " " + totalH,
          width: "100%",
          height: "auto",
          preserveAspectRatio: "none",
          role: "img",
          "aria-label": "近 " + recent.length + " 日 K 线走势",
        },
        priceTicks.map(function (tick) {
          return h(
            "g",
            { key: "grid-" + tick.value.toFixed(2) },
            h("line", { x1: gutter, x2: width - padRight, y1: tick.y.toFixed(1), y2: tick.y.toFixed(1), stroke: COLORS.border, strokeWidth: "1", strokeDasharray: "2 6" }),
            h("text", { x: gutter - 6, y: (tick.y + 4).toFixed(1), fill: COLORS.muted, fontSize: "10.5", textAnchor: "end", fontFamily: NUM_FONT }, tick.value.toFixed(2)),
          );
        }),
        recent.map(function (row, index) {
          var color = row.close >= row.open ? COLORS.up : COLORS.down;
          var x = xAt(index);
          var top = scaleY(Math.max(row.open, row.close));
          var bottom = scaleY(Math.min(row.open, row.close));
          var bodyH = Math.max(1, bottom - top);
          return h(
            "g",
            { key: "candle-" + index },
            h("line", { x1: x.toFixed(1), x2: x.toFixed(1), y1: scaleY(row.high).toFixed(1), y2: scaleY(row.low).toFixed(1), stroke: color, strokeWidth: "1" }),
            h("rect", { x: (x - bodyW / 2).toFixed(1), y: top.toFixed(1), width: bodyW.toFixed(1), height: bodyH.toFixed(1), fill: row.close >= row.open ? color : "#fff", stroke: color, strokeWidth: "1" }),
          );
        }),
        h("path", { d: buildMaPath(maSeries.ma5), fill: "none", stroke: "#d98b3f", strokeWidth: "1.2" }),
        h("path", { d: buildMaPath(maSeries.ma10), fill: "none", stroke: "#4a8fc7", strokeWidth: "1.2" }),
        h("path", { d: buildMaPath(maSeries.ma20), fill: "none", stroke: "#9b6bd6", strokeWidth: "1.2" }),
        h("line", { x1: gutter, y1: volTop, x2: width - padRight, y2: volTop, stroke: COLORS.border, strokeWidth: "1" }),
        recent.map(function (row, index) {
          var color = row.close >= row.open ? COLORS.up : COLORS.down;
          var x = xAt(index);
          var y = volY(row.volume || 0);
          return h("rect", { key: "vol-" + index, x: (x - bodyW / 2).toFixed(1), y: y.toFixed(1), width: bodyW.toFixed(1), height: Math.max(1, volTop + volH - 8 - y).toFixed(1), fill: color, opacity: "0.5" });
        }),
        h("text", { x: width - padRight, y: 11, fill: COLORS.muted, fontSize: "10.5", textAnchor: "end", fontFamily: NUM_FONT }, last.date + "  " + last.close.toFixed(2)),
      );
    }

    /* ------------------------------ 业务分区 ------------------------------ */

    function IndexGrid(props) {
      var indices = props.indices || [];
      if (!indices.length) return h(EmptyHint, null, "指数报价暂不可用");
      var width = props.panelWidth || 0;
      // 10 个指数：宽屏固定 5 列（5×2 对齐），手机等窄屏 2 列（5×2 竖排），
      // 避免 4+4+2 / 3+3+3+1 这类不齐的残行。
      var columns = width >= 700 || !width ? "repeat(5, minmax(0, 1fr))" : "repeat(2, minmax(0, 1fr))";
      return h(
        "div",
        {
          "data-wallstreet-indices": "",
          style: {
            display: "grid",
            gridTemplateColumns: columns,
            gap: 10,
          },
        },
        indices.map(function (item) {
          var color = !isNum(item.changePct)
            ? COLORS.muted
            : item.changePct >= 0
              ? COLORS.up
              : COLORS.down;
          // 卡底统一展示成交额：十个指数的迷你走势覆盖不一致（美股分钟数据只有一两个点），
          // 之前只有上证卡有 sparkline、其余是文字，视觉上不齐；这里统一成同一形式。
          return h(
            "div",
            {
              key: item.secid,
              "data-wallstreet-index": item.code,
              style: {
                border: "1px solid " + COLORS.border,
                borderRadius: 10,
                padding: "9px 11px",
                background: "color-mix(in srgb, currentColor 2%, transparent)",
                minWidth: 0,
                overflow: "hidden",
              },
            },
            h(
              "div",
              { style: { display: "flex", alignItems: "baseline", gap: 6 } },
              h("span", { style: { fontSize: 12.5, fontWeight: 600 } }, item.name),
              h("span", { style: { flex: 1 } }),
              item.group !== "cn" ? h(Tag, { color: COLORS.muted }, item.group === "hk" ? "港股" : "美股") : null,
            ),
            h(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "baseline",
                  flexWrap: "wrap",
                  columnGap: 8,
                  rowGap: 1,
                  marginTop: 4,
                  minWidth: 0,
                },
              },
              h(
                "span",
                {
                  style: {
                    fontSize: 17,
                    fontWeight: 600,
                    fontFamily: NUM_FONT,
                    fontVariantNumeric: "tabular-nums",
                    flexShrink: 0,
                  },
                },
                priceText(item.price),
              ),
              h(
                "span",
                {
                  style: {
                    fontSize: 12.5,
                    color: color,
                    fontFamily: NUM_FONT,
                    fontVariantNumeric: "tabular-nums",
                    flexShrink: 0,
                  },
                },
                pctText(item.changePct),
              ),
              h(
                "span",
                {
                  style: {
                    fontSize: 11,
                    color: COLORS.muted,
                    fontFamily: NUM_FONT,
                    fontVariantNumeric: "tabular-nums",
                    flexShrink: 0,
                  },
                },
                pointText(item.change),
              ),
            ),
            h(
              "div",
              {
                "data-wallstreet-index-turnover": item.code,
                style: {
                  marginTop: 2,
                  height: 28,
                  display: "flex",
                  alignItems: "center",
                  fontSize: 11,
                  color: COLORS.muted,
                  fontFamily: NUM_FONT,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                },
              },
              "成交 " + yi(item.turnover),
            ),
          );
        }),
      );
    }

    /** 市场温度：半圆仪表 + 分项打分 + 文字信号。 */
    function TemperatureCard(props) {
      var analysis = props.analysis;
      if (!analysis) return h(EmptyHint, null, "温度分析暂不可用");
      var score = clamp(analysis.temperature || 0, 0, 100);
      var color = toneColor(analysis.label && analysis.label.tone);
      var radius = 44;
      var circumference = Math.PI * radius;
      var arc = "M 8 56 A " + radius + " " + radius + " 0 0 1 " + (8 + radius * 2) + " 56";
      var dash = (score / 100) * circumference;
      var scores = analysis.scores || {};

      return h(
        "div",
        { "data-wallstreet-temperature": "", style: { display: "flex", flexDirection: "column", gap: 10 } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" } },
          h(
            "svg",
            { viewBox: "0 0 104 64", width: 132, height: 78, style: { flexShrink: 0 }, "aria-label": "市场温度 " + score + " 分" },
            h("path", { d: arc, fill: "none", stroke: COLORS.chip, strokeWidth: "9", strokeLinecap: "round" }),
            h("path", {
              d: arc,
              fill: "none",
              stroke: color,
              strokeWidth: "9",
              strokeLinecap: "round",
              strokeDasharray: dash.toFixed(1) + " " + circumference.toFixed(1),
            }),
            h(
              "text",
              {
                x: 52,
                y: 50,
                textAnchor: "middle",
                fill: "currentColor",
                fontSize: "21",
                fontWeight: "700",
                fontFamily: NUM_FONT,
              },
              String(score),
            ),
            h(
              "text",
              { x: 52, y: 62, textAnchor: "middle", fill: COLORS.muted, fontSize: "10" },
              "市场温度 / 100",
            ),
          ),
          h(
            "div",
            { style: { flex: "1 1 180px", minWidth: 0 } },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
              h("span", { style: { fontSize: 20, fontWeight: 700, color: color, whiteSpace: "nowrap" } }, analysis.label ? analysis.label.text : "—"),
              h("span", { style: { fontSize: 11.5, color: COLORS.muted, minWidth: 0 } }, "综合上涨宽度、涨跌停、量能、动量"),
            ),
            h(
              "div",
              { style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 } },
              Object.keys(scores).map(function (key) {
                var labels = { breadth: "宽度", limit: "涨跌停", volume: "量能", momentum: "动量" };
                return h(
                  "span",
                  {
                    key: key,
                    style: {
                      fontSize: 11,
                      padding: "1px 7px",
                      borderRadius: 6,
                      background: COLORS.chip,
                      color: COLORS.muted,
                      fontVariantNumeric: "tabular-nums",
                    },
                  },
                  labels[key] + " " + scores[key],
                );
              }),
            ),
          ),
        ),
        (analysis.signals || []).length
          ? h(
              "ul",
              { style: { margin: 0, paddingLeft: 16, fontSize: 12.5, lineHeight: 1.75 } },
              analysis.signals.map(function (signal, index) {
                return h("li", { key: index, style: { color: "color-mix(in srgb, currentColor 82%, transparent)" } }, signal);
              }),
            )
          : null,
      );
    }

    /** 市场宽度：涨/跌/平 + 涨停/跌停 + 堆叠条。 */
    function BreadthCard(props) {
      var breadth = props.breadth;
      if (!breadth) return h(EmptyHint, null, "涨跌分布暂不可用");
      var up = breadth.up || 0;
      var down = breadth.down || 0;
      var flat = breadth.flat || 0;
      var total = up + down + flat || 1;
      var upPct = (up / total) * 100;
      var flatPct = (flat / total) * 100;
      var downPct = (down / total) * 100;
      var limitText = (breadth.limitUp || 0) + " / " + (breadth.limitDown || 0);

      return h(
        "div",
        { "data-wallstreet-breadth": "", style: { display: "flex", flexDirection: "column", gap: 10 } },
        h(
          "div",
          { style: { display: "grid", gridTemplateColumns: props.compact ? "repeat(2, minmax(0, 1fr))" : "repeat(4, minmax(0, 1fr))", gap: 8 } },
          h(
            "div",
            null,
            h("div", { style: { fontSize: 11.5, color: COLORS.muted } }, "上涨"),
            h("div", { style: { fontSize: 19, fontWeight: 700, color: COLORS.up, fontFamily: NUM_FONT, fontVariantNumeric: "tabular-nums" } }, String(up)),
          ),
          h(
            "div",
            null,
            h("div", { style: { fontSize: 11.5, color: COLORS.muted } }, "下跌"),
            h("div", { style: { fontSize: 19, fontWeight: 700, color: COLORS.down, fontFamily: NUM_FONT, fontVariantNumeric: "tabular-nums" } }, String(down)),
          ),
          h(
            "div",
            null,
            h("div", { style: { fontSize: 11.5, color: COLORS.muted } }, "平盘"),
            h("div", { style: { fontSize: 19, fontWeight: 700, color: COLORS.muted, fontFamily: NUM_FONT, fontVariantNumeric: "tabular-nums" } }, String(flat)),
          ),
          h(
            "div",
            null,
            h("div", { style: { fontSize: 11.5, color: COLORS.muted } }, "涨停 / 跌停"),
            h("div", { style: { fontSize: 19, fontWeight: 700, fontFamily: NUM_FONT, fontVariantNumeric: "tabular-nums" } }, limitText),
          ),
        ),
        h(
          "div",
          { style: { display: "flex", height: 10, borderRadius: 5, overflow: "hidden", background: COLORS.chip } },
          h("div", { style: { width: upPct + "%", background: COLORS.up } }),
          h("div", { style: { width: flatPct + "%", background: COLORS.borderStrong } }),
          h("div", { style: { width: downPct + "%", background: COLORS.down } }),
        ),
        h(
          "div",
          { style: { fontSize: 11.5, color: COLORS.muted } },
          "上涨占比 " + upPct.toFixed(1) + "% · 共 " + total + " 家（含北交所）",
        ),
        h(
          "div",
          {
            "data-wallstreet-breadth5": "",
            style: { fontSize: 11.5, color: COLORS.muted, fontFamily: NUM_FONT },
          },
          breadth.up5 != null && breadth.down5 != null
            ? "近 5 日累计：上涨 " + breadth.up5 + " 家 / 下跌 " + breadth.down5 + " 家"
            : "近 5 日累计：暂不可用",
        ),
      );
    }

    /** 板块行：hover 有反馈、可点击；有 24h 资讯时在涨跌幅旁边挂「资讯 N」徽标。 */
    function SectorRow(props) {
      var hoverState = react.useState(false);
      var hover = hoverState[0];
      var setHover = hoverState[1];
      var row = props.row || {};
      var clickable = typeof props.onPick === "function" && !!row.name;
      // props.news 现在是 {count, basis, members}：basis=members 表示按成分股算的，
      // =keywords 表示上游成分股没拿到、退回关键词口径（徽标上要能看出区别）。
      var newsInfo = props.news && typeof props.news === "object" ? props.news : null;
      var news = newsInfo && isNum(newsInfo.count) ? newsInfo.count : isNum(props.news) ? props.news : 0;
      return h(
        "div",
        {
          "data-wallstreet-sector-row": row.name || "",
          onClick: function () {
            if (clickable) props.onPick(row.name, row.code);
          },
          onMouseEnter: function () {
            if (clickable) setHover(true);
          },
          onMouseLeave: function () {
            setHover(false);
          },
          title: clickable ? "查看「" + row.name + "」相关资讯" : "",
          style: {
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            fontSize: 12.5,
            padding: "3px 6px",
            margin: "0 -6px",
            borderRadius: 6,
            fontVariantNumeric: "tabular-nums",
            cursor: clickable ? "pointer" : "default",
            background: hover ? COLORS.chip : "transparent",
            transition: "background 120ms ease",
          },
        },
        h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.name),
        h(
          "span",
          { style: { color: COLORS.muted, fontSize: 11 } },
          row.mainInflow == null ? "" : "主力 " + signedYi(row.mainInflow),
        ),
        news > 0
          ? h(
              "span",
              {
                "data-wallstreet-sector-news": news,
                title:
                  newsInfo && newsInfo.basis === "members"
                    ? "按板块成分股（" + (newsInfo.members || 0) + " 只）统计的 24h 资讯"
                    : "关键词口径：还没拿到该板块成分股，标题命中核心词即计入",
                style: { flexShrink: 0 },
              },
              h(Tag, null, "资讯 " + news),
            )
          : null,
        h("span", { style: { color: props.color, fontWeight: 600, width: 58, textAlign: "right" } }, pctText(row.changePct)),
      );
    }

    /** 行业板块：领涨 / 领跌，各带主力净流入；行可点击进资讯筛选，右侧挂 24h 资讯数。 */
    function SectorCard(props) {
      var sectors = props.sectors;
      // 一次请求拿全部板块的 24h 资讯数（最多 16 个名字）；拿不到就整体不显示徽标，不影响板块列表本身。
      var names = [];
      // 名字后面带上板块代码（BKxxxx）：后端有 code 就不用翻板块名单，能直接抓成分股。
      var seen = {};
      var collect = function (rows) {
        (rows || []).forEach(function (row) {
          if (!row || !row.name) return;
          var name = String(row.name);
          if (seen[name]) return;
          seen[name] = true;
          var code = row.code && /^BK\d+$/.test(String(row.code)) ? String(row.code) : "";
          names.push(code ? name + ":" + code : name);
        });
      };
      if (sectors) {
        collect(sectors.gainers);
        collect(sectors.losers);
      }
      var namesKey = names.slice(0, 16).join(",");
      var newsState = react.useState(null);
      var newsMap = newsState[0];
      var setNewsMap = newsState[1];
      react.useEffect(
        function () {
          if (!namesKey) {
            setNewsMap(null);
            return undefined;
          }
          var alive = true;
          // 只发一次，不轮询；盘面卸载（alive=false）后不再 setState。
          hubFetch("/hub/sectors?names=" + encodeURIComponent(namesKey) + "&since=24h")
            .then(function (body) {
              if (!alive) return;
              var map = {};
              (Array.isArray(body.sectors) ? body.sectors : []).forEach(function (item) {
                if (!item || !item.name) return;
                var key = String(item.name).split(":")[0];
                map[key] = {
                  count: isNum(item.events) ? item.events : 0,
                  basis: item.basis === "members" ? "members" : "keywords",
                  members: isNum(item.members) ? item.members : 0,
                };
              });
              setNewsMap(map);
            })
            .catch(function () {
              if (alive) setNewsMap(null);
            });
          return function () {
            alive = false;
          };
        },
        [namesKey],
      );
      if (!sectors || ((sectors.gainers || []).length === 0 && (sectors.losers || []).length === 0)) {
        return h(EmptyHint, null, "板块数据暂不可用");
      }
      var renderList = function (rows, color) {
        return h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 2 } },
          rows.map(function (row) {
            return h(SectorRow, {
              key: row.code + color,
              row: row,
              color: color,
              news: newsMap ? newsMap[row.name] : null,
              onPick: props.onPickSector,
            });
          }),
        );
      };
      return h(
        "div",
        { "data-wallstreet-sectors": "", style: { display: "grid", gridTemplateColumns: props.compact ? "minmax(0, 1fr)" : "1fr 1fr", gap: 14 } },
        h(
          "div",
          null,
          h("div", { style: { fontSize: 11.5, color: COLORS.muted, marginBottom: 4 } }, "领涨行业"),
          renderList(sectors.gainers || [], COLORS.up),
        ),
        h(
          "div",
          null,
          h("div", { style: { fontSize: 11.5, color: COLORS.muted, marginBottom: 4 } }, "领跌行业"),
          renderList(sectors.losers || [], COLORS.down),
        ),
      );
    }

    /** 上证 60 日日K（蜡烛）+ 均线 + 量能比。 */
    function KlineCard(props) {
      var kline = props.kline;
      if (!kline) return h(EmptyHint, null, "日线趋势暂不可用");
      var maParts = [];
      ["ma5", "ma10", "ma20", "ma60"].forEach(function (key) {
        if (isNum(kline[key])) maParts.push(key.toUpperCase().replace("MA", "MA") + " " + kline[key].toFixed(2));
      });
      return h(
        "div",
        { "data-wallstreet-kline": "" },
        h(KlineChart, { kline: kline }),
        h(
          "div",
          { style: { display: "flex", flexWrap: "wrap", gap: 12, fontSize: 11.5, color: COLORS.muted, marginTop: 6 } },
          h("span", null, "蜡烛 红涨绿跌"),
          h("span", { style: { color: "#d98b3f" } }, "MA5"),
          h("span", { style: { color: "#4a8fc7" } }, "MA10"),
          h("span", { style: { color: "#9b6bd6" } }, "MA20"),
          h("span", null, "量能比 " + (isNum(kline.volumeRatio) ? kline.volumeRatio.toFixed(2) : "—") + "（今 / 5 日均）"),
          h("span", { style: { flex: 1 } }),
          h("span", null, maParts.join(" · ")),
        ),
      );
    }

    /* ------------------------------ 数据轮询 ------------------------------ */

    function useOverview() {
      var state = react.useState({ data: null, loading: true, error: null });
      var data = state[0];
      var setState = state[1];
      var aliveRef = react.useRef(true);
      var loadingRef = react.useRef(false);

      var load = react.useCallback(function () {
        if (loadingRef.current) return;
        loadingRef.current = true;
        fetch(API + "/overview", { headers: { accept: "application/json" } })
          .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
          })
          .then(function (payload) {
            if (!aliveRef.current) return;
            setState({ data: payload, loading: false, error: null });
          })
          .catch(function (error) {
            if (!aliveRef.current) return;
            setState(function (previous) {
              return {
                data: previous.data,
                loading: false,
                error: "行情数据加载失败：" + (error && error.message ? error.message : "未知错误"),
              };
            });
          })
          .finally(function () {
            loadingRef.current = false;
          });
      }, []);

      react.useEffect(function () {
        aliveRef.current = true;
        load();
        var timer = setInterval(function () {
          if (!document.hidden) load();
        }, POLL_MS);
        return function () {
          aliveRef.current = false;
          clearInterval(timer);
        };
      }, [load]);

      return { data: data.data, loading: data.loading, error: data.error, reload: load };
    }

    /* ------------------------------ quant 数据（量化研究视图） ------------------------------ */

    /**
     * 数据来自市场数据管线 + 随插件归档的 quant 研究快照，只读、不启动 Python：
     *  - /quant/overview  每日数据（两融/估值/涨跌停/龙虎榜/期货/新闻/资金流）
     *  - /quant/research  归档回测结论与 34 份策略结果（docs/CONCLUSION.md 口径）
     *  - /quant/holdings  持仓集中度快照
     */
    var QUANT_ENDPOINTS = {
      overview: "/quant/overview",
      research: "/quant/research",
      holdings: "/quant/holdings",
    };

    function useQuantData() {
      var state = react.useState({
        loading: true,
        error: null,
        overview: null,
        research: null,
        holdings: null,
        partialErrors: [],
      });
      var current = state[0];
      var setState = state[1];
      var aliveRef = react.useRef(true);
      var loadingRef = react.useRef(false);

      var load = react.useCallback(function () {
        if (loadingRef.current) return;
        loadingRef.current = true;
        setState(function (previous) {
          return Object.assign({}, previous, { loading: true });
        });
        var keys = Object.keys(QUANT_ENDPOINTS);
        Promise.all(
          keys.map(function (key) {
            return fetch(API + QUANT_ENDPOINTS[key], { headers: { accept: "application/json" } })
              .then(function (response) {
                if (!response.ok) throw new Error("HTTP " + response.status);
                return response.json();
              })
              .then(function (payload) {
                return { key: key, payload: payload };
              })
              .catch(function (error) {
                return { key: key, error: error && error.message ? error.message : "未知错误" };
              });
          }),
        )
          .then(function (results) {
            if (!aliveRef.current) return;
            var next = { loading: false, error: null, partialErrors: [] };
            results.forEach(function (item) {
              if (item.error) next.partialErrors.push(item.key + ": " + item.error);
              else next[item.key] = item.payload;
            });
            if (!next.overview && !next.research && !next.holdings) {
              next.error = "quant 数据加载失败：" + (next.partialErrors[0] || "未知错误");
            }
            setState(next);
          })
          .finally(function () {
            loadingRef.current = false;
          });
      }, []);

      react.useEffect(function () {
        aliveRef.current = true;
        load();
        return function () {
          aliveRef.current = false;
        };
      }, [load]);

      return { data: current, reload: load };
    }

    /** 金额（元）按量级显示：≥1 亿用「亿」，否则用「万」。用于龙虎榜净买入等小金额。 */
    function signedMoney(value) {
      if (!isNum(value)) return "—";
      var sign = value > 0 ? "+" : value < 0 ? "-" : "";
      var abs = Math.abs(value);
      if (abs >= 1e8) return sign + (abs / 1e8).toFixed(2) + " 亿";
      if (abs >= 1e4) return sign + (abs / 1e4).toFixed(0) + " 万";
      return sign + abs.toFixed(0) + " 元";
    }

    /** 涨红跌绿。 */
    function toneOf(value) {
      if (!isNum(value)) return "inherit";
      if (value > 0) return COLORS.up;
      if (value < 0) return COLORS.down;
      return COLORS.muted;
    }

    /** 元 → 亿元（带符号、无「亿」后缀，由调用方拼）。 */
    function yiNumber(value) {
      if (!isNum(value)) return "—";
      return (value / 1e8).toFixed(1);
    }

    function Stat(props) {
      return h(
        "div",
        { style: { minWidth: 86 } },
        h("div", { style: { fontSize: 11.5, color: COLORS.muted } }, props.label),
        h(
          "div",
          {
            style: {
              fontSize: props.size || 15,
              fontWeight: 600,
              fontFamily: NUM_FONT,
              fontVariantNumeric: "tabular-nums",
              color: props.color || "inherit",
            },
          },
          props.value,
        ),
        props.sub ? h("div", { style: { fontSize: 11, color: COLORS.faint } }, props.sub) : null,
      );
    }

    /** 极简表格：columns = [{ key, label, align, render }]。 */
    function MiniTable(props) {
      var columns = props.columns || [];
      var rows = props.rows || [];
      if (!rows.length) return h(EmptyHint, null, props.emptyText || "暂无数据");
      return h(
        "div",
        { style: { overflowX: "auto", maxHeight: props.maxHeight || "none", overflowY: props.maxHeight ? "auto" : "visible" } },
        h(
          "table",
          { style: { width: "100%", borderCollapse: "collapse", fontSize: 12 } },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              columns.map(function (column, index) {
                return h(
                  "th",
                  {
                    key: index,
                    style: {
                      textAlign: column.align || "left",
                      padding: "4px 6px",
                      borderBottom: "1px solid " + COLORS.border,
                      color: COLORS.muted,
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                      position: "sticky",
                      top: 0,
                      zIndex: 2,
                      // sticky 表头必须有实色底，否则滚动时行内容会从表头文字后面透出来。
                      background: "color-mix(in srgb, currentColor 2.5%, #ffffff)",
                      boxShadow: "inset 0 -1px 0 " + COLORS.border,
                    },
                  },
                  column.label,
                );
              }),
            ),
          ),
          h(
            "tbody",
            null,
            rows.map(function (row, rowIndex) {
              return h(
                "tr",
                { key: rowIndex },
                columns.map(function (column, columnIndex) {
                  return h(
                    "td",
                    {
                      key: columnIndex,
                      style: {
                        textAlign: column.align || "left",
                        padding: "4px 6px",
                        borderBottom: "1px solid " + COLORS.border,
                        whiteSpace: "nowrap",
                        fontFamily: column.align === "right" ? NUM_FONT : "inherit",
                        fontVariantNumeric: "tabular-nums",
                        color: column.color ? column.color(row) : "inherit",
                      },
                    },
                    column.render ? column.render(row) : row[column.key] == null ? "—" : String(row[column.key]),
                  );
                }),
              );
            }),
          ),
        ),
      );
    }

    function TabBar(props) {
      return h(
        "div",
        {
          style: { display: "inline-flex", border: "1px solid " + COLORS.border, borderRadius: 8, overflow: "hidden" },
        },
        (props.tabs || []).map(function (tab) {
          var active = tab.id === props.active;
          return h(
            "button",
            {
              key: tab.id,
              type: "button",
              "data-dsh-wallstreet-tab": tab.id,
              onClick: function () {
                props.onChange(tab.id);
              },
              style: {
                padding: "4px 11px",
                fontSize: 12,
                border: 0,
                font: "inherit",
                cursor: "pointer",
                background: active ? COLORS.chip : "transparent",
                color: active ? "inherit" : COLORS.muted,
              },
            },
            tab.label,
          );
        }),
      );
    }

    /* ------------------------------ 量化研究视图 ------------------------------ */

    function ResearchSection(props) {
      var research = props.research;
      if (!research) return null;
      var columns = [
        { key: "displayName", label: "策略" },
        { key: "category", label: "类别" },
        {
          key: "alpha",
          label: "α",
          align: "right",
          render: function (row) {
            return isNum(row.alpha) ? (row.alpha * 100).toFixed(2) + "%" : "—";
          },
          color: function (row) {
            return toneOf(row.alpha);
          },
        },
        {
          key: "mdd",
          label: "回撤",
          align: "right",
          render: function (row) {
            return isNum(row.mdd) ? (row.mdd * 100).toFixed(2) + "%" : "—";
          },
          color: function (row) {
            return COLORS.down;
          },
        },
        {
          key: "actT",
          label: "t (act_t)",
          align: "right",
          render: function (row) {
            return isNum(row.actT) ? row.actT.toFixed(2) : "—";
          },
        },
        {
          key: "grade",
          label: "判定",
          render: function (row) {
            return row.verdict || row.grade;
          },
          color: function (row) {
            return row.grade === "有效" ? COLORS.up : row.grade === "边缘" ? "#d98b3f" : COLORS.muted;
          },
        },
      ];
      var counts = research.counts || {};
      return h(
        SectionCard,
        {
          id: "quant-research",
          title: "研究结论",
          hint: "归档快照：回测结果 + docs/CONCLUSION.md（只读文档口径）",
          extra: research.docsUpdatedAt ? h(Tag, null, "文档更新 " + timeText(research.docsUpdatedAt)) : null,
        },
        h(
          "div",
          { style: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" } },
          h("div", { style: { fontSize: 15, fontWeight: 700 } }, research.headline || "（结论待读取）"),
          research.headlineDetail
            ? h("div", { style: { fontSize: 12.5, color: COLORS.muted } }, research.headlineDetail)
            : null,
        ),
        h(
          "div",
          { style: { display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0" } },
          h(Tag, { color: COLORS.up }, "有效 " + (counts.effective || 0)),
          h(Tag, { color: "#d98b3f" }, "边缘 " + (counts.edge || 0)),
          h(Tag, null, "无效 " + (counts.invalid || 0)),
          h(Tag, null, "回测结果 " + (counts.total || 0) + " 份"),
          research.window ? h(Tag, null, "样本窗口 " + research.window) : null,
        ),
        research.premises && research.premises.length
          ? h(
              "ul",
              { style: { margin: "4px 0 10px", paddingLeft: 18, fontSize: 12, color: COLORS.muted, lineHeight: 1.7 } },
              research.premises.map(function (premise, index) {
                return h("li", { key: index }, premise);
              }),
            )
          : null,
        h(MiniTable, { columns: columns, rows: research.strategies || [], maxHeight: 300, emptyText: "回测结果缺失" }),
        research.warnings && research.warnings.length
          ? h("div", { style: { fontSize: 11.5, color: COLORS.faint, marginTop: 8 } }, research.warnings.join("；"))
          : null,
      );
    }

    /** 异动数据：涨停池 / 龙虎榜 / 涨跌幅榜 / 行业资金流（收盘快照）。 */
    function useMoves() {
      var state = react.useState({ data: null, loading: true, error: null });
      var data = state[0];
      var setState = state[1];
      var aliveRef = react.useRef(true);
      var loadingRef = react.useRef(false);

      var load = react.useCallback(function () {
        if (loadingRef.current) return;
        loadingRef.current = true;
        fetch(API + "/moves", { headers: { accept: "application/json" } })
          .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
          })
          .then(function (payload) {
            loadingRef.current = false;
            if (!aliveRef.current) return;
            setState({ data: payload, loading: false, error: null });
          })
          .catch(function (error) {
            loadingRef.current = false;
            if (!aliveRef.current) return;
            setState(function (prev) {
              return {
                data: prev.data,
                loading: false,
                error: String(error && error.message ? error.message : error),
              };
            });
          });
      }, []);

      react.useEffect(function () {
        aliveRef.current = true;
        load();
        var timer = window.setInterval(function () {
          if (!document.hidden) load();
        }, 60_000);
        return function () {
          aliveRef.current = false;
          window.clearInterval(timer);
        };
      }, [load]);

      return { data: data.data, loading: data.loading, error: data.error, reload: load };
    }

    /** 表格里的股票名：点击打开个股下钻弹层。 */
    function StockLink(props) {
      if (!props.code) return h("span", null, props.children);
      return h(
        "button",
        {
          type: "button",
          "data-wallstreet-stock": props.code,
          onClick: function (event) {
            if (event && event.stopPropagation) event.stopPropagation();
            if (props.onPick) props.onPick(props.code);
          },
          style: {
            border: 0,
            padding: 0,
            background: "transparent",
            font: "inherit",
            color: "inherit",
            cursor: "pointer",
            textAlign: "left",
            textDecoration: "underline dotted",
            textDecorationColor: COLORS.faint,
            textUnderlineOffset: 2,
          },
        },
        props.children,
      );
    }

    /** 个股下钻：报价 + 分时 + 60 日 K（全部来自腾讯行情，只读弹层）。 */
    function StockModal(props) {
      var codeState = react.useState(props.code);
      var code = codeState[0];
      var setCode = codeState[1];
      var queryState = react.useState("");
      var query = queryState[0];
      var setQuery = queryState[1];
      var state = react.useState({ loading: true, data: null, error: "" });
      var view = state[0];
      var setView = state[1];
      var requestRef = react.useRef(0);

      var load = function () {
        if (!code) return;
        var seq = ++requestRef.current;
        setView({ loading: true, data: null, error: "" });
        fetch(API + "/stock?code=" + encodeURIComponent(code), { credentials: "same-origin" })
          .then(function (response) {
            return response.json().then(function (body) {
              if (!response.ok || body.ok === false) {
                throw new Error((body && body.error) || "HTTP " + response.status);
              }
              return body;
            });
          })
          .then(function (body) {
            if (seq !== requestRef.current) return;
            setView({ loading: false, data: body, error: "" });
          })
          .catch(function (error) {
            if (seq !== requestRef.current) return;
            setView({ loading: false, data: null, error: error && error.message ? error.message : "读取失败" });
          });
      };

      react.useEffect(
        function () {
          load();
          return function () {
            requestRef.current += 1;
          };
        },
        [code],
      );

      // Esc 关闭 + 打开弹层时锁住背景滚动（避免弹层后面页面跟着滚）。
      react.useEffect(function () {
        var onKey = function (event) {
          if (event.key === "Escape") props.onClose();
        };
        document.addEventListener("keydown", onKey);
        var previous = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return function () {
          document.removeEventListener("keydown", onKey);
          document.body.style.overflow = previous;
        };
      }, []);

      if (!code) return null;
      var data = view.data;
      var quote = data ? data.quote : null;

      var close = function (event) {
        if (event) event.stopPropagation();
        props.onClose();
      };

      var statItems = quote
        ? [
            ["昨收", priceText(quote.prevClose)],
            ["今开", priceText(quote.open)],
            ["最高", priceText(quote.high)],
            ["最低", priceText(quote.low)],
            ["成交额", isNum(quote.turnover) ? yi(quote.turnover) : "—"],
            ["换手率", isNum(quote.turnoverRate) ? quote.turnoverRate.toFixed(2) + "%" : "—"],
            ["市盈率", isNum(quote.pe) ? quote.pe.toFixed(2) : "—"],
          ]
        : [];

      return h(
        "div",
        {
          "data-dsh-wallstreet-stock-modal": code,
          onClick: close,
          style: {
            position: "fixed",
            inset: 0,
            zIndex: 70,
            background: "rgba(15, 17, 21, 0.38)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          },
        },
        h(
          "div",
          {
            onClick: function (event) {
              event.stopPropagation();
            },
            style: {
              width: "min(920px, 96vw)",
              maxHeight: "90vh",
              overflowY: "auto",
              background: "#fff",
              color: "inherit",
              borderRadius: 12,
              border: "1px solid " + COLORS.border,
              boxShadow: "0 18px 50px rgba(15, 17, 21, 0.22)",
              padding: "14px 16px 18px",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            },
          },
          h(
            "div",
            { style: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" } },
            h("span", { style: { fontSize: 16, fontWeight: 700 } }, data ? data.name || code : code),
            h("span", { style: { fontSize: 12, color: COLORS.muted } }, code),
            h("span", { style: { flex: 1 } }),
            h(Tag, null, "腾讯行情"),
            h(
              "button",
              {
                type: "button",
                "data-dsh-wallstreet-action": "stock-close",
                onClick: close,
                style: {
                  border: "1px solid " + COLORS.border,
                  background: "transparent",
                  borderRadius: 6,
                  padding: "2px 8px",
                  fontSize: 12,
                  cursor: "pointer",
                  font: "inherit",
                  color: "inherit",
                },
              },
              "关闭",
            ),
          ),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
            h("input", {
              value: query,
              placeholder: "搜索其它股票：600519 / 00700 / AAPL",
              "data-dsh-wallstreet-stock-search": "",
              onChange: function (event) {
                setQuery(event.target.value);
              },
              onKeyDown: function (event) {
                if (event.key !== "Enter") return;
                var next = (query || "").trim();
                if (!next) return;
                setCode(next);
                setQuery("");
              },
              style: {
                flex: "1 1 220px",
                maxWidth: 320,
                border: "1px solid " + COLORS.border,
                borderRadius: 6,
                padding: "5px 8px",
                fontSize: 12,
                font: "inherit",
                color: "inherit",
                background: "transparent",
              },
            }),
            h("span", { style: { fontSize: 11.5, color: COLORS.muted } }, "回车切换 · Esc 关闭"),
          ),
          view.loading ? h("div", { style: { padding: 20, fontSize: 13, color: COLORS.muted } }, "正在读取 " + code + " 的分时与日K…") : null,
          view.error
            ? h(
                "div",
                { style: { padding: "8px 0", fontSize: 13 } },
                h("div", { style: { color: COLORS.down, marginBottom: 8 } }, view.error),
                h(ToolbarButton, { action: "stock-retry", onClick: load, primary: true }, "重试"),
              )
            : null,
          quote
            ? h(
                "div",
                null,
                h(
                  "div",
                  { style: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" } },
                  h(
                    "span",
                    { style: { fontSize: 24, fontWeight: 700, fontFamily: NUM_FONT } },
                    priceText(quote.price),
                  ),
                  h(
                    "span",
                    { style: { fontSize: 14, fontFamily: NUM_FONT, color: toneOf(quote.changePct) } },
                    pctText(quote.changePct) + "  " + (isNum(quote.change) && quote.change > 0 ? "+" : "") + (isNum(quote.change) ? quote.change.toFixed(2) : "—"),
                  ),
                  h("span", { style: { flex: 1 } }),
                  h("span", { style: { fontSize: 11.5, color: COLORS.muted } }, quote.time || ""),
                ),
                h(
                  "div",
                  { style: { display: "flex", flexWrap: "wrap", gap: 14, marginTop: 8 } },
                  statItems.map(function (item) {
                    return h(Stat, { key: item[0], label: item[0], value: item[1], size: 13 });
                  }),
                ),
              )
            : null,
          data && data.trend && (data.trend.points || []).length >= 2
            ? h(
                "div",
                { style: { border: "1px solid " + COLORS.border, borderRadius: 10, padding: "10px 12px" } },
                h("div", { style: { fontSize: 12.5, color: COLORS.muted, marginBottom: 6 } }, "分时（价格 / 均价 / 昨收）"),
                h(TrendChart, { trend: data.trend }),
              )
            : null,
          data && data.kline && (data.kline.recent || []).length >= 10
            ? h(
                "div",
                { style: { border: "1px solid " + COLORS.border, borderRadius: 10, padding: "10px 12px" } },
                h("div", { style: { fontSize: 12.5, color: COLORS.muted, marginBottom: 6 } }, "近 60 日日K（蜡烛 / MA5 / MA10 / MA20）"),
                h(KlineChart, { kline: data.kline }),
              )
            : null,
          data &&
          !(data.trend && (data.trend.points || []).length >= 2) &&
          !(data.kline && (data.kline.recent || []).length >= 10)
            ? h(
                "div",
                { style: { padding: "10px 12px", border: "1px dashed " + COLORS.border, borderRadius: 10, fontSize: 12.5, color: COLORS.muted } },
                "该市场腾讯接口暂未提供分时/日K历史，仅显示实时报价。",
              )
            : null,
          data
            ? h(
                "div",
                { style: { fontSize: 11.5, color: COLORS.faint, lineHeight: 1.6 } },
                "数据来源：腾讯公开行情（实时，可能延迟）。仅供研究参考，不构成投资建议。",
                (data.warnings || []).length ? h("br") : null,
                (data.warnings || []).length ? "部分降级：" + data.warnings.join("；") : null,
              )
            : null,
        ),
      );
    }

    function MovesSection(props) {
      var data = props.data || {};
      var pool = data.limitPool || {};
      var lhb = data.lhb || [];
      var movers = data.movers || {};
      var sectorFlow = data.sectorFlow || {};
      var poolRows = pool.rows || [];
      var poolColumns = [
        { key: "name", label: "个股", render: function (row) { return h(StockLink, { code: row.code, name: row.name, onPick: props.onPickStock }, row.name); } },
        { key: "code", label: "代码" },
        { key: "pct", label: "涨幅", align: "right", render: function (row) { return pctText(row.pct); }, color: function () { return COLORS.up; } },
        { key: "firstSeal", label: "首封", align: "right" },
      ];
      if (poolRows.some(function (row) { return isNum(row.boardCount); })) {
        poolColumns.push({
          key: "boardCount",
          label: "连板",
          align: "right",
          render: function (row) { return isNum(row.boardCount) ? row.boardCount + " 板" : "—"; },
        });
      }
      poolColumns.push({ key: "industry", label: "行业" });
      var flowHasLead = (sectorFlow.top || []).concat(sectorFlow.bottom || []).some(function (row) {
        return row && row.leadStock;
      });
      var sectorFlowColumns = function (firstLabel) {
        var columns = [
          { key: "industry", label: firstLabel },
          { key: "net", label: "净额", align: "right", render: function (row) { return signedYi(row.net); }, color: function (row) { return toneOf(row.net); } },
        ];
        if (flowHasLead) {
          columns.push({ key: "leadStock", label: "领涨股" });
          columns.push({
            key: "leadPct",
            label: "领涨",
            align: "right",
            render: function (row) { return pctText(row.leadPct); },
            color: function (row) { return toneOf(row.leadPct); },
          });
        }
        return columns;
      };

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 12 } },
        data.dataMode !== "live" && data.stale && data.marketDate
          ? h(
              "div",
              { style: { fontSize: 12, color: "#d98b3f", border: "1px solid " + COLORS.border, borderRadius: 8, padding: "6px 10px" } },
              "收盘快照日期为 " + data.marketDate + "（" + (data.dataTime || "") + " 抓取），不是最新交易日。",
            )
          : null,
        h(
          "div",
          { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 } },
          h(
            SectionCard,
            {
              title: "涨停池",
              hint: (data.sources && data.sources.limitPool === "live" ? "盘中实时" : "收盘快照") + " · 按首封时间",
              extra: h(Tag, null, "今日 " + (isNum(pool.today) ? pool.today : "—") + " · 昨日 " + (isNum(pool.prev) ? pool.prev : "—")),
            },
            h(MiniTable, {
              columns: poolColumns,
              rows: poolRows,
              maxHeight: 300,
              emptyText: "涨停池缺失",
            }),
          ),
          h(
            SectionCard,
            { title: "龙虎榜", hint: "按净买入额排序 · 前 10" },
            h(MiniTable, {
              columns: [
                { key: "name", label: "个股", render: function (row) { return h(StockLink, { code: row.code, name: row.name, onPick: props.onPickStock }, row.name); } },
                { key: "pct", label: "涨幅", align: "right", render: function (row) { return pctText(row.pct); }, color: function (row) { return toneOf(row.pct); } },
                { key: "net", label: "净买入", align: "right", render: function (row) { return isNum(row.net) ? signedMoney(row.net) : "—"; }, color: function (row) { return toneOf(row.net); } },
                { key: "reason", label: "上榜原因" },
              ],
              rows: lhb,
              maxHeight: 300,
              emptyText: "龙虎榜缺失",
            }),
          ),
        ),
        h(
          "div",
          { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 } },
          h(
            SectionCard,
            { title: "涨跌幅榜", hint: (data.sources && data.sources.movers === "live" ? "盘中实时" : "收盘快照") + " · 涨幅前 8 / 跌幅前 8" },
            h(
              "div",
              { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 } },
              h(MiniTable, {
                columns: [
                  { key: "name", label: "涨幅前 8", render: function (row) { return h(StockLink, { code: row.code, name: row.name, onPick: props.onPickStock }, row.name); } },
                  { key: "pct", label: "幅度", align: "right", render: function (row) { return pctText(row.pct); }, color: function () { return COLORS.up; } },
                ],
                rows: movers.top || [],
              }),
              h(MiniTable, {
                columns: [
                  { key: "name", label: "跌幅前 8", render: function (row) { return h(StockLink, { code: row.code, name: row.name, onPick: props.onPickStock }, row.name); } },
                  { key: "pct", label: "幅度", align: "right", render: function (row) { return pctText(row.pct); }, color: function () { return COLORS.down; } },
                ],
                rows: movers.bottom || [],
              }),
            ),
          ),
          h(
            SectionCard,
            {
              title: "行业资金流",
              hint: (data.sources && data.sources.sectorFlow === "live" ? "盘中实时" : "收盘快照") + " · 净额前 6 / 后 6",
            },
            h(
              "div",
              { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 } },
              h(MiniTable, {
                columns: sectorFlowColumns("净流入前 6"),
                rows: sectorFlow.top || [],
                emptyText: "—",
              }),
              h(MiniTable, {
                columns: sectorFlowColumns("净流出前 6"),
                rows: sectorFlow.bottom || [],
                emptyText: "—",
              }),
            ),
          ),
        ),
      );
    }

    /** 慢数据：估值 / 两融 / 期货商品 / OMO / 新闻公告（来自 /quant/overview）。 */
    function ResearchDataSection(props) {
      var data = props.data || {};
      var valuation = data.valuation || [];
      var margin = data.margin || {};
      var futures = data.futures || [];
      var commodities = data.commodities || {};
      var omo = data.omo || [];

      var valuationRows = valuation.map(function (item) {
        return {
          name: item.name,
          peTtm: item.peTtm,
          peStatic: item.peStatic,
          pctile: item.pctile,
          range: isNum(item.histLow) && isNum(item.histHigh) ? item.histLow + " – " + item.histHigh : "—",
        };
      });

      var marginCard = function (label, node) {
        if (!node) return h(Stat, { label: label, value: "—" });
        return h(
          "div",
          { style: { display: "flex", gap: 18, flexWrap: "wrap" } },
          h(Stat, { label: label + " · 两融余额", value: isNum(node.totalBalance) ? yiNumber(node.totalBalance) + " 亿" : "—", sub: node.date }),
          h(Stat, { label: "融资余额", value: isNum(node.financingBalance) ? yiNumber(node.financingBalance) + " 亿" : "—" }),
          h(Stat, { label: "融资买入", value: isNum(node.financingBuy) ? yiNumber(node.financingBuy) + " 亿" : "—" }),
          h(Stat, { label: "融券余额", value: isNum(node.shortBalance) ? yiNumber(node.shortBalance) + " 亿" : "—" }),
        );
      };

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h(
          "div",
          { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 } },
          h(
            SectionCard,
            { title: "估值分位", hint: "PE(TTM) 历史分位" },
            h(MiniTable, {
              columns: [
                { key: "name", label: "指数" },
                { key: "peTtm", label: "PE(TTM)", align: "right", render: function (row) { return isNum(row.peTtm) ? row.peTtm.toFixed(2) : "—"; } },
                { key: "peStatic", label: "PE(静)", align: "right", render: function (row) { return isNum(row.peStatic) ? row.peStatic.toFixed(2) : "—"; } },
                {
                  key: "pctile",
                  label: "分位",
                  align: "right",
                  render: function (row) { return isNum(row.pctile) ? row.pctile.toFixed(1) + "%" : "—"; },
                  color: function (row) {
                    if (!isNum(row.pctile)) return "inherit";
                    return row.pctile >= 70 ? COLORS.up : row.pctile <= 30 ? COLORS.down : "inherit";
                  },
                },
              ],
              rows: valuationRows,
              emptyText: "估值数据缺失",
            }),
          ),
          h(
            SectionCard,
            { title: "两融余额", hint: "market-report 每日采集" },
            h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } }, marginCard("沪市", margin.sh), marginCard("深市", margin.sz)),
          ),
          h(
            SectionCard,
            { title: "股指期货与商品", hint: "主力连续 / 现货指数" },
            h(
              "div",
              { style: { display: "flex", flexWrap: "wrap", gap: 14 } },
              futures.map(function (item) {
                return h(Stat, {
                  key: item.name,
                  label: item.name,
                  value: priceText(item.price),
                  sub: pctText(item.pct),
                  color: toneOf(item.pct),
                });
              }),
              h(
                "div",
                { style: { display: "flex", flexWrap: "wrap", gap: 14 } },
                commodities.bc ? h(Stat, { label: "生意社 BC 指数", value: priceText(commodities.bc.value), sub: pctText(commodities.bc.pct), color: toneOf(commodities.bc.pct) }) : null,
                commodities.gold ? h(Stat, { label: "沪金", value: priceText(commodities.gold.price), sub: commodities.gold.date }) : null,
                commodities.silver ? h(Stat, { label: "沪银", value: priceText(commodities.silver.price), sub: commodities.silver.date }) : null,
                commodities.copper ? h(Stat, { label: "沪铜", value: priceText(commodities.copper.price), sub: commodities.copper.date }) : null,
                commodities.aluminum ? h(Stat, { label: "沪铝", value: priceText(commodities.aluminum.price), sub: commodities.aluminum.date }) : null,
              ),
            ),
          ),
        ),
        h(
          SectionCard,
          { title: "公开市场操作", hint: "央行 OMO" },
          omo.length
            ? h(
                "ul",
                { style: { margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.8, color: COLORS.muted } },
                omo.map(function (item, index) {
                  return h("li", { key: index }, item.title);
                }),
              )
            : h(EmptyHint, null, "今日暂无 OMO 记录"),
        ),
      );
    }

    /** 财经快讯与公告：新浪滚动 / 华尔街见闻 / 巨潮公告，60s 轮询；每条都能点开原文。 */
    function NewsSection() {
      var state = react.useState({ loading: true, data: null, error: "" });
      var view = state[0];
      var setView = state[1];
      var load = function () {
        fetch(API + "/news?limit=40", { credentials: "same-origin" })
          .then(function (response) {
            return response.json().then(function (body) {
              if (!response.ok || body.ok === false) throw new Error((body && body.error) || "HTTP " + response.status);
              return body;
            });
          })
          .then(function (body) {
            setView({ loading: false, data: body, error: "" });
          })
          .catch(function (error) {
            setView({ loading: false, data: null, error: error && error.message ? error.message : "读取失败" });
          });
      };
      react.useEffect(function () {
        load();
        var timer = setInterval(function () {
          if (!document.hidden) load();
        }, 60000);
        return function () {
          clearInterval(timer);
        };
      }, []);

      var items = (view.data && view.data.items) || [];
      var body;
      if (view.loading) {
        body = h(EmptyHint, null, "正在读取快讯与公告…");
      } else if (view.error) {
        body = h("div", { style: { fontSize: 12.5, color: COLORS.muted } }, "快讯暂不可用：" + view.error);
      } else if (!items.length) {
        body = h(EmptyHint, null, "暂无快讯");
      } else {
        body = h(
          "ul",
          { style: { margin: 0, paddingLeft: 0, listStyle: "none", fontSize: 12.5, lineHeight: 1.7 } },
          items.map(function (item, index) {
            return h(
              "li",
              { key: "news-" + index, style: { borderBottom: "1px solid " + COLORS.border } },
              h(
                "a",
                {
                  href: item.url || "#",
                  target: "_blank",
                  rel: "noopener noreferrer",
                  style: { color: "inherit", textDecoration: "none", display: "block", padding: "6px 0" },
                },
                h("span", { style: { color: COLORS.faint, marginRight: 8, fontVariantNumeric: "tabular-nums" } }, item.time || "—"),
                h(Tag, null, item.source || "快讯"),
                h("span", { style: { marginLeft: 8, fontWeight: 600 } }, item.title || ""),
                item.summary ? h("div", { style: { color: COLORS.muted, marginTop: 2, marginLeft: 48 } }, item.summary) : null,
              ),
            );
          }),
        );
      }
      return h(
        SectionCard,
        {
          id: "news",
          title: "财经快讯与公告",
          hint: "新浪财经 · 华尔街见闻 · 巨潮公告，点击跳原文",
          extra: h(Tag, null, items.length ? items.length + " 条" : "—"),
        },
        body,
      );
    }

    function MovesPanel(props) {
      var moves = useMoves();
      var payload = moves.data;
      var onMetaRef = react.useRef(props.onMeta);
      onMetaRef.current = props.onMeta;
      react.useEffect(
        function () {
          if (onMetaRef.current) {
            onMetaRef.current({
              loading: !!moves.loading,
              fetchedAt: payload ? payload.fetchedAt : "",
              dataDate: payload ? payload.marketDate : "",
              dataMode: payload ? payload.dataMode : "",
              dataTime: payload ? payload.dataTime : "",
            });
          }
        },
        [moves.loading, payload],
      );
      react.useEffect(
        function () {
          if (props.registerReload) props.registerReload(moves.reload);
        },
        [moves.reload],
      );

      var body;
      if (!payload && moves.loading) {
        body = h("div", { style: { padding: 24, fontSize: 13, color: COLORS.muted } }, "正在读取收盘快照…");
      } else if (!payload && moves.error) {
        body = h(
          "div",
          { style: { padding: 24, fontSize: 13 } },
          h("div", { style: { color: COLORS.down, marginBottom: 8 } }, moves.error),
          h(ToolbarButton, { action: "moves-retry", onClick: moves.reload, primary: true }, "重试"),
        );
      } else {
        var warnings = payload.warnings || [];
        body = h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 12 } },
          moves.error
            ? h("div", { style: { fontSize: 12, color: COLORS.down } }, moves.error + "（显示的是上一次成功的数据）")
            : null,
          h(MovesSection, { data: payload, onPickStock: props.onPickStock }),
          h(
            "div",
            { style: { fontSize: 11.5, color: COLORS.faint, lineHeight: 1.7 } },
            payload.dataMode === "live"
              ? "数据来源：涨停池、涨跌幅榜与行业资金流为东方财富实时接口（60 秒缓存）；龙虎榜等收盘后才有的数据取 market-report 收盘快照。"
              : "数据来源：market-report 每日收盘快照（写入本插件 data/ 下的 market_data.json、flow_full.json）。",
            warnings.length ? h("br") : null,
            warnings.length ? "部分数据降级：" + warnings.join("；") : null,
          ),
        );
      }

      return h(
        "div",
        {
          "data-dsh-wallstreet-moves": "",
          style: { padding: "14px 16px 26px", display: "flex", flexDirection: "column", gap: 12, overflowY: "auto", minHeight: 0, flex: 1 },
        },
        body,
      );
    }

    function HoldingsSection(props) {
      var snapshot = props.holdings && props.holdings.snapshot;
      if (!snapshot) {
        return h(
          SectionCard,
          { id: "quant-holdings", title: "持仓集中度", hint: "quant/data/holdings_concentration_*.json" },
          h(EmptyHint, null, (props.holdings && props.holdings.warnings && props.holdings.warnings[0]) || "还没有快照"),
        );
      }
      var groups = Object.keys(snapshot.groupWeight || {}).sort(function (a, b) {
        return (snapshot.groupWeight[b] || 0) - (snapshot.groupWeight[a] || 0);
      });
      return h(
        SectionCard,
        {
          id: "quant-holdings",
          title: "持仓集中度",
          hint: "quant scripts/holdings_concentration_alert.py 快照",
          extra: h(Tag, null, snapshot.date + (isNum(snapshot.ageDays) && snapshot.ageDays > 7 ? " · 已 " + snapshot.ageDays + " 天" : "")),
        },
        h(
          "div",
          { style: { display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 10 } },
          h(Stat, { label: "持仓只数", value: isNum(snapshot.holdingsCount) ? String(snapshot.holdingsCount) : "—" }),
          h(Stat, { label: "最大分组", value: snapshot.maxGroup || "—", sub: isNum(snapshot.maxGroupWeight) ? (snapshot.maxGroupWeight * 100).toFixed(1) + "%" : "" }),
          h(Stat, { label: "风险簇暴露", value: isNum(snapshot.riskClusterWeight) ? (snapshot.riskClusterWeight * 100).toFixed(1) + "%" : "—" }),
          h(Stat, { label: "分组 HHI", value: isNum(snapshot.hhi) ? snapshot.hhi.toFixed(3) : "—" }),
          h(Stat, { label: "组合涨跌(等权)", value: isNum(snapshot.portfolioPct) ? pctText(snapshot.portfolioPct * 100) : "—", color: toneOf(snapshot.portfolioPct) }),
        ),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 } },
          groups.map(function (group) {
            var weight = snapshot.groupWeight[group] || 0;
            return h(
              "div",
              { key: group, style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12 } },
              h("span", { style: { width: 44, color: COLORS.muted } }, group),
              h(
                "div",
                { style: { flex: 1, height: 8, borderRadius: 999, background: COLORS.chip, overflow: "hidden" } },
                h("div", { style: { width: clamp(weight * 100, 0, 100) + "%", height: "100%", background: weight > 0.5 ? COLORS.up : "#4a8fc7" } }),
              ),
              h("span", { style: { width: 52, textAlign: "right", fontVariantNumeric: "tabular-nums" } }, (weight * 100).toFixed(1) + "%"),
              h("span", { style: { width: 120, color: COLORS.faint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, ((snapshot.groupMembers && snapshot.groupMembers[group]) || []).join(" ")),
            );
          }),
        ),
        (snapshot.alerts || []).length
          ? h(
              "ul",
              { style: { margin: 0, paddingLeft: 18, fontSize: 12, color: "#d98b3f", lineHeight: 1.7 } },
              snapshot.alerts.map(function (alert, index) {
                return h("li", { key: index }, alert);
              }),
            )
          : h("div", { style: { fontSize: 12, color: COLORS.down } }, "集中度在阈值内"),
      );
    }

    /** 市场情绪历史：涨停/跌停家数与成交额（读 market-report 的每日快照 jsonl）。 */
    function HistorySection() {
      var state = react.useState({ loading: true, data: null, error: "" });
      var view = state[0];
      var setView = state[1];

      react.useEffect(function () {
        var alive = true;
        fetch(API + "/history?days=40", { credentials: "same-origin" })
          .then(function (response) {
            return response.json().then(function (body) {
              if (!response.ok || body.ok === false) throw new Error((body && body.error) || "HTTP " + response.status);
              return body;
            });
          })
          .then(function (body) {
            if (alive) setView({ loading: false, data: body, error: "" });
          })
          .catch(function (error) {
            if (alive) setView({ loading: false, data: null, error: error && error.message ? error.message : "读取失败" });
          });
        return function () {
          alive = false;
        };
      }, []);

      var body = null;
      if (view.loading) {
        body = h(EmptyHint, null, "正在读取历史快照…");
      } else if (view.error) {
        body = h("div", { style: { fontSize: 12.5, color: COLORS.muted } }, "历史快照暂不可用：" + view.error);
      } else {
        var points = (view.data && view.data.points) || [];
        if (points.length < 2) {
          body = h(EmptyHint, null, "历史快照不足 2 个交易日");
        } else {
          var W = 640;
          var H = 132;
          var PAD = 8;
          var peaks = points
            .map(function (point) {
              return Math.max(point.zt || 0, point.dt || 0);
            })
            .sort(function (a, b) {
              return a - b;
            });
          var peakMax = peaks[peaks.length - 1] || 1;
          var p90 = peaks[Math.min(peaks.length - 1, Math.floor(peaks.length * 0.9))] || 1;
          // 纵轴用 90 分位而不是最大值，避免单日极端涨停潮把整条曲线压扁；超出部分被 SVG 裁掉，峰值在标题里标注。
          var ztMax = Math.max(p90, 20, Math.round(peakMax * 0.55));
          var xAt = function (index) {
            return PAD + (index / (points.length - 1)) * (W - PAD * 2);
          };
          var yAt = function (value) {
            return H - PAD - ((value || 0) / ztMax) * (H - PAD * 2);
          };
          var linePath = function (key) {
            return points
              .map(function (point, index) {
                return (index === 0 ? "M " : "L ") + xAt(index).toFixed(1) + " " + yAt(point[key]).toFixed(1);
              })
              .join(" ");
          };
          var latest = points[points.length - 1];
          var amounts = points.map(function (point) { return point.amount; }).filter(isNum);
          var amtMax = Math.max.apply(null, amounts.concat([1]));
          var amtMin = Math.min.apply(null, amounts.concat([0]));
          var AH = 44;
          var amountPath = amounts.length > 1
            ? amounts
                .map(function (value, index) {
                  var x = PAD + (index / (amounts.length - 1)) * (W - PAD * 2);
                  var y = AH - PAD - ((value - amtMin) / (amtMax - amtMin || 1)) * (AH - PAD * 2);
                  return (index === 0 ? "M " : "L ") + x.toFixed(1) + " " + y.toFixed(1);
                })
                .join(" ")
            : "";

          body = h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 10 } },
            h(
              "div",
              { style: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", fontSize: 11.5, color: COLORS.muted } },
              h("span", null, "涨停 / 跌停家数（近 " + points.length + " 个交易日）"),
              h("span", { style: { flex: 1 } }),
              h("span", { style: { fontFamily: NUM_FONT } }, points[0].date + " → " + latest.date),
              h("span", { style: { fontFamily: NUM_FONT } }, "峰值 " + peakMax + " 家"),
              h("span", { style: { fontFamily: NUM_FONT, color: COLORS.faint } }, "纵轴 " + ztMax + " 家（超出裁切）"),
            ),
            h(
              "svg",
              { viewBox: "0 0 " + W + " " + H, width: "100%", height: 118, style: { display: "block" }, "aria-label": "涨停跌停历史" },
              [0.25, 0.5, 0.75].map(function (fraction) {
                return h("line", {
                  key: "grid" + fraction,
                  x1: PAD,
                  x2: W - PAD,
                  y1: (H - PAD) - fraction * (H - PAD * 2),
                  y2: (H - PAD) - fraction * (H - PAD * 2),
                  stroke: COLORS.border,
                  strokeDasharray: "3 4",
                });
              }),
              h("path", { d: linePath("zt"), fill: "none", stroke: COLORS.up, strokeWidth: "1.6" }),
              h("path", { d: linePath("dt"), fill: "none", stroke: COLORS.down, strokeWidth: "1.4" }),
            ),
            h(
              "div",
              { style: { display: "flex", gap: 16, fontSize: 12, flexWrap: "wrap" } },
              h(
                "span",
                { style: { display: "inline-flex", gap: 6, alignItems: "center" } },
                h("span", { style: { width: 8, height: 2, background: COLORS.up } }),
                h("span", null, "涨停 " + (isNum(latest.zt) ? latest.zt : "—") + " 家"),
              ),
              h(
                "span",
                { style: { display: "inline-flex", gap: 6, alignItems: "center" } },
                h("span", { style: { width: 8, height: 2, background: COLORS.down } }),
                h("span", null, "跌停 " + (isNum(latest.dt) ? latest.dt : "—") + " 家"),
              ),
              h("span", { style: { flex: 1 } }),
            ),
            amounts.length > 1
              ? h(
                  "div",
                  null,
                  h(
                    "div",
                    { style: { display: "flex", alignItems: "baseline", gap: 10, fontSize: 11.5, color: COLORS.muted, marginTop: 4 } },
                    h("span", null, "两市成交额（亿元）"),
                    h("span", { style: { fontFamily: NUM_FONT } }, "最新 " + yi(latest.amount)),
                    h("span", { style: { flex: 1 } }),
                  ),
                  h(
                    "svg",
                    { viewBox: "0 0 " + W + " " + AH, width: "100%", height: 44, style: { display: "block" }, "aria-label": "成交额历史" },
                    h("path", { d: amountPath, fill: "none", stroke: COLORS.muted, strokeWidth: "1.4" }),
                  ),
                )
              : null,
          );
        }
      }

      return h(
        SectionCard,
        { title: "市场情绪历史", hint: "涨停 / 跌停 / 成交额", extra: h("div", { style: { display: "flex", gap: 6 } }, h(Tag, null, "收盘快照"), h(Tag, null, "本地历史")) },
        h("div", { "data-wallstreet-history": "", style: { minWidth: 0 } }, body),
      );
    }

    /* ------------------------------ 资料检索（妙想 / Tavily） ------------------------------ */

    var SEARCH_ENGINES = [
      { id: "mx", label: "金融资讯", hint: "东方财富妙想：新闻 / 公告 / 研报" },
      { id: "tavily", label: "全网", hint: "Tavily：政策原文 / 海外报道 / 官网" },
    ];

    function ResourceSearch() {
      var state = react.useState({
        query: "",
        engine: "mx",
        loading: false,
        error: "",
        results: [],
        answer: "",
        total: 0,
      });
      var s = state[0];
      var setState = state[1];

      var run = react.useCallback(function (query, engine) {
        var q = String(query || "").trim();
        if (!q) return;
        setState(function (prev) {
          return Object.assign({}, prev, { loading: true, error: "", results: [], answer: "", total: 0 });
        });
        var url =
          API +
          "/research/search?engine=" +
          encodeURIComponent(engine) +
          "&limit=10&answer=1&q=" +
          encodeURIComponent(q);
        fetch(url, { headers: { accept: "application/json" }, credentials: "same-origin" })
          .then(function (response) {
            return response
              .json()
              .catch(function () {
                return {};
              })
              .then(function (body) {
                return { status: response.status, body: body || {} };
              });
          })
          .then(function (res) {
            if (res.body.ok === false || res.status >= 400) {
              throw new Error(res.body.error || "HTTP " + res.status);
            }
            setState(function (prev) {
              return Object.assign({}, prev, {
                loading: false,
                error: "",
                results: res.body.results || [],
                answer: res.body.answer || "",
                total: res.body.total || 0,
              });
            });
          })
          .catch(function (error) {
            setState(function (prev) {
              return Object.assign({}, prev, {
                loading: false,
                error: error && error.message ? error.message : "检索失败",
              });
            });
          });
      }, []);

      var engineMeta = SEARCH_ENGINES.filter(function (item) {
        return item.id === s.engine;
      })[0];

      return h(
        SectionCard,
        {
          id: "resource-search",
          title: "资料检索",
          hint: engineMeta ? engineMeta.hint : "",
          extra: h(
            "div",
            { style: { display: "flex", gap: 6 } },
            SEARCH_ENGINES.map(function (engine) {
              var on = engine.id === s.engine;
              return h(
                "button",
                {
                  key: engine.id,
                  type: "button",
                  "data-engine": engine.id,
                  onClick: function () {
                    setState(function (prev) {
                      return Object.assign({}, prev, { engine: engine.id });
                    });
                  },
                  style: {
                    padding: "3px 10px",
                    borderRadius: 999,
                    fontSize: 11.5,
                    cursor: "pointer",
                    border: "1px solid " + (on ? COLORS.border : "transparent"),
                    background: on ? COLORS.chip : "transparent",
                    color: on ? "inherit" : COLORS.muted,
                  },
                },
                engine.label,
              );
            }),
          ),
        },
        h(
          "div",
          { style: { display: "flex", gap: 8 } },
          h("input", {
            type: "search",
            value: s.query,
            placeholder: s.engine === "mx" ? "例：固态电池 进展 / 某只股票 最新公告" : "例：美股 AI 资本开支 最新",
            "data-resource-query": "",
            onChange: function (event) {
              var value = event.target.value;
              setState(function (prev) {
                return Object.assign({}, prev, { query: value });
              });
            },
            onKeyDown: function (event) {
              if (event.key === "Enter") run(event.target.value, s.engine);
            },
            style: {
              flex: 1,
              minWidth: 0,
              padding: "7px 10px",
              borderRadius: 8,
              border: "1px solid " + COLORS.border,
              background: "transparent",
              color: "inherit",
              fontSize: 13,
            },
          }),
          h(
            ToolbarButton,
            {
              action: "resource-search",
              primary: true,
              onClick: function () {
                run(s.query, s.engine);
              },
            },
            s.loading ? "检索中…" : "检索",
          ),
        ),
        s.error
          ? h("div", { style: { fontSize: 12.5, color: COLORS.down, marginTop: 8 } }, s.error)
          : null,
        s.answer
          ? h(
              "div",
              {
                style: {
                  marginTop: 10,
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: COLORS.chip,
                  fontSize: 12.5,
                  lineHeight: 1.7,
                },
              },
              s.answer,
            )
          : null,
        s.results.length
          ? h(
              "div",
              { style: { marginTop: 10, display: "flex", flexDirection: "column", gap: 8 } },
              s.results.map(function (item, index) {
                return h(
                  "div",
                  { key: index, "data-resource-result": "", style: { fontSize: 12.5, lineHeight: 1.65 } },
                  h(
                    "a",
                    {
                      href: item.url || "#",
                      target: "_blank",
                      rel: "noreferrer noopener",
                      style: { color: "inherit", fontWeight: 600, textDecoration: "none" },
                    },
                    item.title || "（无标题）",
                  ),
                  h(
                    "div",
                    { style: { fontSize: 11.5, color: COLORS.muted } },
                    [item.source, item.published, item.authority].filter(Boolean).join(" · "),
                  ),
                  h("div", { style: { color: COLORS.muted } }, item.snippet || ""),
                );
              }),
              h(
                "div",
                { style: { fontSize: 11, color: COLORS.faint } },
                "共 " + s.total + " 条；点击标题在新窗口打开原文",
              ),
            )
          : s.loading
            ? h("div", { style: { marginTop: 10, fontSize: 12.5, color: COLORS.muted } }, "正在检索…")
            : null,
      );
    }

    function ResearchPanel(props) {
      var quant = useQuantData();
      var data = quant.data || {};
      var onMetaRef = react.useRef(props.onMeta);
      onMetaRef.current = props.onMeta;
      react.useEffect(
        function () {
          if (onMetaRef.current) {
            onMetaRef.current({
              loading: !!data.loading,
              fetchedAt: data.overview ? data.overview.fetchedAt : "",
              dataDate: data.overview ? data.overview.dataDate : "",
            });
          }
        },
        [data.loading, data.overview],
      );
      react.useEffect(
        function () {
          if (props.registerReload) props.registerReload(quant.reload);
        },
        [quant.reload],
      );

      var sections = [];
      if (data.error) {
        sections.push(
          h(
            "div",
            { style: { fontSize: 13, color: COLORS.down, padding: "10px 0" } },
            data.error,
            h("div", { style: { marginTop: 8 } }, h(ToolbarButton, { action: "research-retry", onClick: quant.reload, primary: true }, "重试")),
          ),
        );
      }
      sections.push(h(ResourceSearch, { key: "resource-search" }));
      if (data.research) sections.push(h(ResearchSection, { key: "research", research: data.research }));
      sections.push(h(HistorySection, { key: "history" }));
      if (data.overview) sections.push(h(ResearchDataSection, { key: "slow", data: data.overview }));
      sections.push(h(NewsSection, { key: "news" }));
      sections.push(h(HoldingsSection, { key: "holdings", holdings: data.holdings }));
      if (!data.error && data.loading && !data.overview && !data.research) {
        sections.push(h("div", { style: { padding: 24, fontSize: 13, color: COLORS.muted } }, "正在读取归档研究数据…"));
      }

      var warnings = [];
      if (data.overview && data.overview.warnings) warnings = warnings.concat(data.overview.warnings);
      if (data.research && data.research.warnings) warnings = warnings.concat(data.research.warnings);
      if (data.holdings && data.holdings.warnings) warnings = warnings.concat(data.holdings.warnings);
      if (data.partialErrors) warnings = warnings.concat(data.partialErrors);

      return h(
        "div",
        {
          "data-dsh-wallstreet-research": "",
          style: { padding: "14px 16px 26px", display: "flex", flexDirection: "column", gap: 12, overflowY: "auto", minHeight: 0, flex: 1 },
        },
        sections,
        h(
          "div",
          { style: { fontSize: 11.5, color: COLORS.faint, lineHeight: 1.7, paddingTop: 2 } },
          "研究结论与回测结果来自 dsh-wallstreet/data/quant-archive（只读归档）；估值/两融/期货由 market-report 每日采集；快讯与公告来自新浪财经、华尔街见闻、巨潮公告并保留原文链接；情绪历史读 market-report 的每日快照 jsonl。",
          h("br"),
          "回测含幸存者偏差，α 应视为上界；仅供研究，不构成投资建议。",
          warnings.length ? h("br") : null,
          warnings.length ? "部分数据降级：" + warnings.join("；") : null,
        ),
      );
    }

    /* ------------------------------ 资讯 view（信息资讯集散中心） ------------------------------ */

    /**
     * hub 请求的统一入口：非 2xx、返回非 JSON、`ok: false` 一律翻译成人话错误。
     * 后端 hub 可能还没部署完，所以错误只落到面板的错误态，绝不抛到组件外面。
     */
    function hubFetch(path, init) {
      var options = Object.assign({ credentials: "same-origin", headers: { accept: "application/json" } }, init || {});
      return fetch(API + path, options).then(function (response) {
        if (!response.ok) {
          throw new Error("资讯服务暂未就绪（HTTP " + response.status + "）");
        }
        return response.json().then(
          function (body) {
            if (!body || body.ok === false) throw new Error((body && body.error) || "资讯服务暂未就绪");
            return body;
          },
          function () {
            throw new Error("资讯服务暂未就绪（返回内容不是 JSON）");
          },
        );
      });
    }

    function hubErrorText(error) {
      var message = error && error.message ? String(error.message) : "未知错误";
      return message.indexOf("资讯服务") === 0 ? message : "资讯服务暂未就绪：" + message;
    }

    var HUB_KIND_CHIPS = [
      { id: "", label: "全部" },
      { id: "flash", label: "快讯" },
      { id: "announcement", label: "公告" },
      { id: "report", label: "研报" },
      { id: "policy", label: "政策" },
    ];

    function hubKindLabel(kind) {
      for (var index = 0; index < HUB_KIND_CHIPS.length; index += 1) {
        if (HUB_KIND_CHIPS[index].id === kind) return HUB_KIND_CHIPS[index].label;
      }
      return kind || "资讯";
    }

    /**
     * 重要度拆解文案：把后端 `importanceParts` 拼成「为什么这条分高」，
     * 给圆点和标题的 title 属性用。分量缺失时退回只显示总分。
     */
    var HUB_PART_LABELS = {
      kind: "类型基准",
      type: "事件类型",
      ticker: "涉及个股",
      multi: "多标的",
      watch: "自选持仓",
      hot: "涨停/龙虎榜",
      market: "市场含义",
      demote: "政务降权",
      degraded: "时间兜底",
      diffusion: "多源扩散",
    };

    function hubImportanceDetail(event) {
      var parts = event && event.importanceParts;
      var head = "重要度 " + (event && event.importance != null ? event.importance : "—");
      if (!parts || typeof parts !== "object") return head;
      var lines = [];
      Object.keys(HUB_PART_LABELS).forEach(function (key) {
        var value = parts[key];
        if (!isNum(value) || value === 0) return;
        lines.push("  " + HUB_PART_LABELS[key] + " " + (value > 0 ? "+" : "") + value);
      });
      return lines.length ? head + "\n" + lines.join("\n") : head;
    }

    /** AI 摘要行的色调：利好红、利空绿（A 股口径），中性灰。 */
    function hubSentimentColor(sentiment) {
      if (sentiment === "利好") return COLORS.up;
      if (sentiment === "利空") return COLORS.down;
      return COLORS.muted;
    }

    /**
     * 事件时间：今天只给 HH:MM，跨天补 MM-DD，列表里一眼能看出新旧。
     * 后端 timeUnknown=true 表示上游只给了日期（巨潮沪市公告，ts 落在当日 00:00），
     * 这时显示「当日」，不要用 00:00 冒充一个不存在的时分。
     */
    function hubTimeText(ts, timeUnknown) {
      if (!isNum(ts) || ts <= 0) return "—";
      var date = new Date(ts);
      if (!Number.isFinite(date.getTime())) return "—";
      var pad = function (value) {
        return value < 10 ? "0" + value : String(value);
      };
      var now = new Date();
      var sameDay =
        date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
      // 未来的日期 = 盘后披露、次日才生效的公告（巨潮就是这么标的）。
      // 直接显示「11-26 当日」会让人以为穿越了，改成「11-26 次日」。
      // 注意不能用「差 6 小时」判断：盘后 18:30 看次日 00:00 只差 5.5 小时。
      var isFuture = !sameDay && date.getTime() > now.getTime();
      if (timeUnknown === true) {
        if (sameDay) return "当日";
        var stamp = pad(date.getMonth() + 1) + "-" + pad(date.getDate());
        return isFuture ? stamp + " 次日" : stamp + " 当日";
      }
      var clock = pad(date.getHours()) + ":" + pad(date.getMinutes());
      return sameDay ? clock : pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + clock;
    }

    function hubAgoText(iso) {
      var time = iso ? new Date(iso).getTime() : NaN;
      if (!Number.isFinite(time)) return "";
      var diff = Math.max(0, Date.now() - time);
      if (diff < 60000) return "刚刚";
      if (diff < 3600000) return Math.round(diff / 60000) + " 分钟前";
      if (diff < 86400000) return Math.round(diff / 3600000) + " 小时前";
      return Math.round(diff / 86400000) + " 天前";
    }

    /** 源健康度的时间戳（`lastOk` / `lastErrorAt`）是 epoch ms，不是 ISO，单独格式化。 */
    function hubStampText(ts) {
      if (!isNum(ts) || ts <= 0) return "—";
      var date = new Date(ts);
      if (!Number.isFinite(date.getTime())) return "—";
      var pad = function (value) {
        return value < 10 ? "0" + value : String(value);
      };
      var sameYear = new Date().getFullYear() === date.getFullYear();
      var day = pad(date.getMonth() + 1) + "-" + pad(date.getDate());
      var clock = pad(date.getHours()) + ":" + pad(date.getMinutes());
      return (sameYear ? "" : date.getFullYear() + "-") + day + " " + clock;
    }

    function hubCountText(value) {
      if (!isNum(value)) return "—";
      return value.toLocaleString("zh-CN");
    }

    /** 单条事件：收起是一行摘要，点开列出簇内各源标题与原文链接。 */
    function NewsEventRow(props) {
      var event = props.event || {};
      var important = isNum(event.importance) && event.importance >= 70;
      var sourceCount = isNum(event.sourceCount) ? event.sourceCount : 0;
      var sources = Array.isArray(event.sources) ? event.sources.slice(0, 8) : [];
      var tickers = Array.isArray(event.tickers) ? event.tickers.slice(0, 6) : [];
      var stopClick = function (clickEvent) {
        if (clickEvent && clickEvent.stopPropagation) clickEvent.stopPropagation();
      };

      var head = h(
        "div",
        { style: { display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 0 4px" } },
        h(
          "span",
          {
            "data-wallstreet-news-time": "",
            title: event.timeUnknown === true ? "上游只提供日期，没有时分" : "",
            style: {
              width: 64,
              flexShrink: 0,
              paddingTop: 2,
              fontSize: 11.5,
              color: COLORS.faint,
              fontFamily: NUM_FONT,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            },
          },
          hubTimeText(event.ts, event.timeUnknown === true),
        ),
        important
          ? h("span", {
              title: hubImportanceDetail(event),
              style: { width: 6, height: 6, borderRadius: 3, background: COLORS.up, marginTop: 7, flexShrink: 0 },
            })
          : null,
        h(
          "span",
          {
            style: {
              flex: 1,
              minWidth: 0,
              fontSize: 12.5,
              lineHeight: 1.65,
              fontWeight: important ? 600 : 500,
              color: important ? COLORS.up : "inherit",
              wordBreak: "break-word",
            },
          },
          event.title || "（无标题）",
        ),
        sourceCount > 1 ? h(Tag, null, sourceCount + " 家") : null,
        event.eventType ? h(Tag, null, event.eventType) : h(Tag, null, hubKindLabel(event.kind)),
      );

      // 个股 chips 之后接板块 chips（最多 2 个），样式与个股 chip 一致，外层包一层锚点便于验收。
      var sectors = Array.isArray(event.sectors) ? event.sectors.slice(0, 2) : [];
      var chipNodes = tickers
        .map(function (ticker, index) {
          return h(Tag, { key: "ticker-" + index }, ticker);
        })
        .concat(
          sectors.map(function (sector, index) {
            return h(
              "span",
              { key: "sector-" + index, "data-wallstreet-news-sector-chip": sector },
              h(Tag, null, sector),
            );
          }),
        );
      // AI 摘要：只对高分事件生成，没生成过就不占位（不显示空壳）。
      var llm = event.llm && event.llm.summary ? event.llm : null;
      var aiLine = llm
        ? h(
            "div",
            {
              "data-wallstreet-news-ai": event.id || "",
              style: {
                display: "flex",
                alignItems: "baseline",
                gap: 6,
                margin: "0 0 2px 60px",
                fontSize: 12,
                lineHeight: 1.6,
                color: COLORS.muted,
              },
            },
            h(
              "span",
              {
                title: llm.model ? "模型 " + llm.model : "AI 摘要",
                style: {
                  flexShrink: 0,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.4,
                  padding: "0 4px",
                  borderRadius: 3,
                  border: "1px solid " + COLORS.border,
                  color: hubSentimentColor(llm.sentiment),
                },
              },
              "AI",
            ),
            h("span", { style: { color: hubSentimentColor(llm.sentiment), flexShrink: 0 } }, llm.sentiment || "中性"),
            h("span", { style: { minWidth: 0, wordBreak: "break-word" } }, llm.summary),
          )
        : null;

      var chipLine = chipNodes.length
        ? h(
            "div",
            {
              "data-wallstreet-news-chips": "",
              style: { display: "flex", gap: 4, flexWrap: "wrap", paddingLeft: 60, paddingBottom: 6 },
            },
            chipNodes,
          )
        : null;

      var detail = null;
      if (props.expanded) {
        detail = h(
          "div",
          {
            style: {
              margin: "0 0 8px 60px",
              paddingLeft: 10,
              borderLeft: "2px solid " + COLORS.border,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            },
          },
          sources.length
            ? sources.map(function (source, index) {
                var title = source.title || "（无标题）";
                return h(
                  "div",
                  {
                    key: "source-" + index,
                    style: { display: "flex", alignItems: "baseline", gap: 6, fontSize: 12, lineHeight: 1.6 },
                  },
                  h(Tag, null, source.label || source.source || "来源"),
                  source.url
                    ? h(
                        "a",
                        {
                          href: source.url,
                          target: "_blank",
                          rel: "noopener noreferrer",
                          onClick: stopClick,
                          style: {
                            color: "inherit",
                            textDecoration: "underline dotted",
                            textDecorationColor: COLORS.faint,
                            textUnderlineOffset: 2,
                            minWidth: 0,
                            wordBreak: "break-word",
                          },
                        },
                        title,
                      )
                    : h("span", { style: { color: COLORS.muted, minWidth: 0 } }, title),
                  h("span", { style: { flex: 1 } }),
                  h(
                    "span",
                    { style: { color: COLORS.faint, fontSize: 11, fontFamily: NUM_FONT, whiteSpace: "nowrap" } },
                    hubTimeText(source.ts),
                  ),
                );
              })
            : h("div", { style: { fontSize: 12, color: COLORS.muted } }, "簇内没有可用的源明细"),
          event.url
            ? h(
                "a",
                {
                  href: event.url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  onClick: stopClick,
                  style: { fontSize: 11.5, color: COLORS.muted, textDecoration: "none", paddingTop: 2 },
                },
                "打开原文 →",
              )
            : null,
        );
      }

      return h(
        "div",
        {
          "data-wallstreet-news-event": event.id || "",
          "data-wallstreet-news-expanded": props.expanded ? "1" : "0",
          onClick: function () {
            if (props.onToggle) props.onToggle();
          },
          style: { borderBottom: "1px solid " + COLORS.border, cursor: "pointer" },
        },
        head,
        aiLine,
        chipLine,
        detail,
      );
    }

    /**
     * 「今日头版」：一屏回答「今天最值得看什么 / 哪个板块热 / 我关注的票有没有消息 / 一共多少量」。
     * 数据来自 `/hub/frontpage`，全部规则可算，不调模型。
     */
    function HubFrontpage(props) {
      var page = props.data;
      if (!page) {
        return props.error
          ? h("div", { style: { fontSize: 12, color: COLORS.muted } }, "头版暂不可用：" + props.error)
          : null;
      }
      var counts = page.counts || {};
      var highlights = Array.isArray(page.highlights) ? page.highlights : [];
      var sectors = Array.isArray(page.sectors) ? page.sectors : [];
      var watch = Array.isArray(page.watch) ? page.watch : [];

      var statLine = [
        isNum(counts.events) ? counts.events + " 条事件" : null,
        isNum(counts.multiSource) ? counts.multiSource + " 条多源" : null,
        isNum(counts.summarized) ? counts.summarized + " 条有 AI 摘要" : null,
        isNum(counts.sources) ? counts.sources + " 个源" : null,
      ]
        .filter(Boolean)
        .join(" · ");

      var renderItem = function (item, index, extra) {
        var important = isNum(item.importance) && item.importance >= 70;
        return h(
          "div",
          {
            key: "fp-" + (item.id || index),
            "data-wallstreet-frontpage-item": item.id || "",
            style: { padding: "5px 0", borderTop: index === 0 ? "none" : "1px solid " + COLORS.border },
          },
          h(
            "div",
            { style: { display: "flex", alignItems: "baseline", gap: 8 } },
            h(
              "span",
              {
                style: {
                  flexShrink: 0,
                  fontSize: 11,
                  fontFamily: NUM_FONT,
                  color: important ? COLORS.up : COLORS.faint,
                  fontWeight: important ? 700 : 400,
                  width: 26,
                },
              },
              isNum(item.importance) ? item.importance : "—",
            ),
            h(
              "span",
              {
                style: {
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12.5,
                  lineHeight: 1.6,
                  fontWeight: important ? 600 : 500,
                  color: important ? COLORS.up : "inherit",
                  wordBreak: "break-word",
                },
              },
              item.title || "（无标题）",
            ),
            isNum(item.sourceCount) && item.sourceCount > 1 ? h(Tag, null, item.sourceCount + " 家") : null,
            item.eventType ? h(Tag, null, item.eventType) : null,
          ),
          item.ai
            ? h(
                "div",
                { style: { fontSize: 11.5, color: COLORS.muted, paddingLeft: 34, lineHeight: 1.5 } },
                "AI " + (item.ai.sentiment || "中性") + " " + item.ai.summary,
              )
            : null,
          item.tickers && item.tickers.length
            ? h(
                "div",
                { style: { display: "flex", gap: 4, flexWrap: "wrap", paddingLeft: 34, paddingTop: 2 } },
                item.tickers.slice(0, 4).map(function (code, codeIndex) {
                  return h(Tag, { key: "fp-t-" + index + "-" + codeIndex }, code);
                }),
                extra ? h(Tag, { key: "fp-w-" + index }, extra) : null,
              )
            : null,
        );
      };

      return h(
        "div",
        {
          "data-wallstreet-frontpage": "",
          style: {
            border: "1px solid " + COLORS.border,
            borderRadius: 12,
            padding: "10px 14px",
            background: "color-mix(in srgb, currentColor 2.5%, transparent)",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", paddingBottom: 4 } },
          h("span", { style: { fontSize: 13, fontWeight: 700, letterSpacing: 0.2 } }, "今日头版"),
          h("span", { style: { fontSize: 11.5, color: COLORS.faint, fontFamily: NUM_FONT } }, page.date || ""),
          h("span", { style: { flex: 1 } }),
          h("span", { style: { fontSize: 11.5, color: COLORS.muted } }, statLine),
          props.onRefresh
            ? h(
                ToolbarButton,
                { action: "frontpage-refresh", onClick: props.onRefresh, title: "重新读取头版" },
                props.refreshing ? "刷新中…" : "刷新头版",
              )
            : null,
          props.onDigest
            ? h(
                ToolbarButton,
                { action: "frontpage-digest", onClick: props.onDigest, title: "把今天导出成一份 Markdown 日报" },
                props.digesting ? "导出中…" : "导出日报",
              )
            : null,
          props.onPublish
            ? h(
                ToolbarButton,
                { action: "frontpage-publish", onClick: props.onPublish, title: "把当天日报投喂进知识库（dsh-kb）" },
                props.publishing ? "发布中…" : "发到知识库",
              )
            : null,
          h(ToolbarButton, { action: "frontpage-toggle", onClick: props.onToggle }, props.collapsed ? "展开" : "收起"),
        ),
        props.digestMessage
          ? h("div", { style: { fontSize: 11.5, color: COLORS.muted, paddingBottom: 4 } }, props.digestMessage)
          : null,
        props.collapsed
          ? null
          : h(
              "div",
              { style: { display: "grid", gridTemplateColumns: props.compact ? "minmax(0, 1fr)" : "minmax(0, 1.55fr) minmax(0, 1fr)", gap: 16 } },
              h(
                "div",
                null,
                h("div", { style: { fontSize: 11, color: COLORS.faint, paddingBottom: 2 } }, "今日要闻"),
                highlights.length
                  ? highlights.map(function (item, index) {
                      return renderItem(item, index, null);
                    })
                  : h("div", { style: { fontSize: 12, color: COLORS.muted, padding: "4px 0" } }, "今天还没有够格的要闻"),
              ),
              h(
                "div",
                null,
                h("div", { style: { fontSize: 11, color: COLORS.faint, paddingBottom: 4 } }, "板块热度"),
                sectors.length
                  ? h(
                      "div",
                      { style: { display: "flex", flexDirection: "column", gap: 3 } },
                      sectors.map(function (sector, index) {
                        return h(
                          "div",
                          { key: "fp-sec-" + index, style: { display: "flex", alignItems: "baseline", gap: 8, fontSize: 12 } },
                          h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, sector.name),
                          h("span", { style: { color: COLORS.muted, fontSize: 11, fontFamily: NUM_FONT } }, sector.events + " 条"),
                          isNum(sector.importance)
                            ? h("span", { style: { color: COLORS.faint, fontSize: 11, fontFamily: NUM_FONT } }, "最高 " + sector.importance)
                            : null,
                        );
                      }),
                    )
                  : h("div", { style: { fontSize: 12, color: COLORS.muted } }, "还没有板块热度"),
                h(
                  "div",
                  { style: { fontSize: 11, color: COLORS.faint, padding: "10px 0 4px" } },
                  watch.length ? "我关注的票（" + watch.length + "）" : "我关注的票",
                ),
                watch.length
                  ? h(
                      "div",
                      { style: { display: "flex", flexDirection: "column", gap: 4 } },
                      watch.map(function (item, index) {
                        return h(
                          "div",
                          { key: "fp-watch-" + index, style: { fontSize: 12, lineHeight: 1.55 } },
                          h(Tag, null, item.watchedTicker || ""),
                          " ",
                          h("span", { style: { wordBreak: "break-word" } }, item.title || ""),
                        );
                      }),
                    )
                  : h(
                      "div",
                      { style: { fontSize: 12, color: COLORS.muted } },
                      isNum(page.watchedCount) && page.watchedCount > 0 ? "今天关注的票没有新消息" : "没有持仓快照，无法判断",
                    ),
              ),
            ),
      );
    }

    /** 可选的抓取间隔（毫秒 → 面板文案）。和后端 config.js 的夹紧区间一致。 */
    var HUB_INTERVALS = [60000, 120000, 300000, 600000, 1800000];

    function hubIntervalLabel(ms) {
      var minutes = Math.round((isNum(ms) ? ms : 0) / 60000);
      if (minutes >= 60) return minutes / 60 + " 小时";
      return minutes + " 分钟";
    }

    /**
     * 源配置卡：逐源开关 + 抓取间隔，保存到 `data/hub-settings.json`。
     * 只提交**改过的**源（draft 里有的），没动过的继续走适配器默认值。
     */
    function HubSourceConfig(props) {
      var sources = Array.isArray(props.data && props.data.sources) ? props.data.sources : [];
      var draft = props.draft || {};
      // 摘要模型：从 DSH 模型列表里选一个并记住；不可用只展示，不降级。
      var modelInfo = (props.data && props.data.model) || null;
      var modelSelected = (modelInfo && modelInfo.selected) || null;
      var modelProviders = (modelInfo && modelInfo.providers) || [];
      var modelValueOf = function (sel) {
        return sel ? sel.provider + "::" + sel.model : "";
      };
      var modelState = react.useState(modelValueOf(modelSelected));
      var modelValue = modelState[0];
      var setModelValue = modelState[1];
      react.useEffect(
        function () {
          setModelValue(modelValueOf(modelSelected));
        },
        [modelInfo]
      );
      var modelOptions = [{ value: "", label: "跟随 DSH 默认模型" }];
      modelProviders.forEach(function (provider) {
        (provider.models || []).forEach(function (model) {
          modelOptions.push({
            value: provider.id + "::" + model.id,
            label: (provider.name || provider.id) + " · " + (model.name || model.id),
          });
        });
      });
      var modelAvailable = modelInfo ? modelInfo.available !== false : true;
      var modelRow = h(
        "div",
        {
          "data-wallstreet-hub-model": "",
          style: {
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            padding: "7px 0",
            borderBottom: "1px solid " + COLORS.border,
            fontSize: 11.5,
          },
        },
        h("span", { style: { fontWeight: 600 } }, "AI 模型"),
        h(
          "select",
          {
            "data-wallstreet-hub-model-select": "",
            value: modelValue,
            disabled: modelProviders.length === 0,
            onChange: function (event) {
              setModelValue(event.target.value);
            },
            style: {
              font: "inherit",
              fontSize: 11.5,
              padding: "3px 6px",
              borderRadius: 6,
              border: "1px solid " + COLORS.border,
              background: COLORS.chip,
              maxWidth: 300,
            },
          },
          modelOptions.map(function (option) {
            return h("option", { key: option.value, value: option.value }, option.label);
          })
        ),
        h(
          ToolbarButton,
          {
            action: "hub-model-save",
            onClick: function () {
              var parts = String(modelValue || "").split("::");
              if (props.onModelSave) props.onModelSave(parts[0] || "", parts[1] || "");
            },
          },
          "记住"
        ),
        h(
          "span",
          {
            style: { color: modelAvailable ? COLORS.muted : COLORS.down, fontSize: 11 },
          },
          modelInfo
            ? modelAvailable
              ? modelSelected
                ? "可用"
                : "跟随 DSH 默认"
              : "不可用：" + (modelInfo.reason || modelSelected.provider + "/" + modelSelected.model)
            : "读取中…"
        )
      );
      var rows = sources.map(function (source) {
        var entry = Object.assign({}, source, draft[source.id] || {});
        var on = entry.enabled !== false;
        var changed = Boolean(draft[source.id]);
        return h(
          "div",
          {
            key: source.id,
            "data-wallstreet-source-config": source.id,
            style: {
              display: "grid",
              gridTemplateColumns: "minmax(0, 1.4fr) 56px 74px 96px minmax(0, 1fr)",
              gap: 8,
              alignItems: "center",
              padding: "5px 0",
              borderTop: "1px solid " + COLORS.border,
              fontSize: 12,
              opacity: on ? 1 : 0.55,
            },
          },
          h("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, source.label),
          h("span", { style: { fontSize: 10.5, color: COLORS.faint } }, hubKindLabel(source.kind)),
          h(
            "button",
            {
              type: "button",
              "data-wallstreet-source-toggle": source.id,
              onClick: function () {
                if (props.onToggle) props.onToggle(source.id, !on);
              },
              style: {
                font: "inherit",
                fontSize: 11.5,
                padding: "2px 0",
                borderRadius: 999,
                border: "1px solid " + COLORS.border,
                background: on ? COLORS.chip : "transparent",
                color: on ? "inherit" : COLORS.muted,
                cursor: "pointer",
              },
            },
            on ? "启用" : "停用",
          ),
          h(
            "select",
            {
              "data-wallstreet-source-interval": source.id,
              value: String(entry.intervalMs),
              disabled: !on,
              onChange: function (event) {
                if (props.onInterval) props.onInterval(source.id, Number(event.target.value));
              },
              style: {
                font: "inherit",
                fontSize: 11.5,
                padding: "2px 4px",
                borderRadius: 6,
                border: "1px solid " + COLORS.border,
                background: "transparent",
                color: "inherit",
              },
            },
            // 选项要包含这条源**当前的**间隔：有些源默认 1 小时，不在固定选项里，
            // 不补进来的话 select 会回落到第一项，显示成「1 分钟」。
            (function () {
              var options = HUB_INTERVALS.slice();
              if (isNum(entry.intervalMs) && options.indexOf(entry.intervalMs) < 0) options.push(entry.intervalMs);
              options.sort(function (a, b) {
                return a - b;
              });
              return options.map(function (ms) {
                return h("option", { key: ms, value: String(ms) }, hubIntervalLabel(ms));
              });
            })(),
          ),
          h(
            "span",
            { style: { fontSize: 11, color: COLORS.faint, whiteSpace: "nowrap" } },
            changed ? "已改（未保存）" : source.overridden ? "自定义" : "默认 " + hubIntervalLabel(source.defaultIntervalMs),
          ),
        );
      });

      var changedCount = Object.keys(draft).length;
      return h(
        "div",
        {
          "data-wallstreet-source-config-card": "",
          style: {
            border: "1px solid " + COLORS.border,
            borderRadius: 12,
            padding: "10px 14px",
            background: "color-mix(in srgb, currentColor 2.5%, transparent)",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", paddingBottom: 6 } },
          h("span", { style: { fontSize: 12.5, fontWeight: 600 } }, "源配置"),
          h(
            "span",
            { style: { fontSize: 11, color: COLORS.faint } },
            changedCount > 0 ? changedCount + " 条改动待保存" : "改开关或间隔后点保存，下一轮入站生效",
          ),
          h("span", { style: { flex: 1 } }),
          props.saving
            ? h("span", { style: { fontSize: 11.5, color: COLORS.muted } }, "保存中…")
            : h(
                ToolbarButton,
                { action: "hub-config-save", onClick: props.onSave, primary: true },
                "保存",
              ),
          h(ToolbarButton, { action: "hub-config-cancel", onClick: props.onClose }, "收起"),
        ),
        modelRow,
        props.message
          ? h("div", { style: { fontSize: 11.5, color: /失败|不/.test(props.message) ? COLORS.down : COLORS.muted, paddingBottom: 4 } }, props.message)
          : null,
        rows.length ? rows : h("div", { style: { fontSize: 12.5, color: COLORS.muted, padding: "6px 0" } }, "没有可配置的源"),
        props.data && props.data.configPath
          ? h(
              "div",
              { style: { fontSize: 10.5, color: COLORS.faint, paddingTop: 6 } },
              "配置文件：" + props.data.configPath,
            )
          : null,
      );
    }

    /**
     * AI 模型条：常驻在资讯页顶部，不藏在「配置源」里。
     * 数据来自 /hub/model（DSH 模型列表 + 当前选择 + 可用性）；不可用只展示，不降级。
     */
    function HubModelBar() {
      var state = react.useState({ loading: true, data: null, saving: false, message: "" });
      var info = state[0];
      var setInfo = state[1];
      var load = function () {
        hubFetch("/hub/model")
          .then(function (body) {
            setInfo({ loading: false, data: body, saving: false, message: "" });
          })
          .catch(function (error) {
            setInfo({ loading: false, data: null, saving: false, message: hubErrorText(error) });
          });
      };
      react.useEffect(function () {
        load();
      }, []);
      var providers = (info.data && info.data.providers) || [];
      var selected = (info.data && info.data.selected) || null;
      var current = selected ? selected.provider + "::" + selected.model : "";
      var available = info.data ? info.data.available !== false : true;
      var options = [{ value: "", label: "跟随 DSH 默认模型" }];
      providers.forEach(function (provider) {
        (provider.models || []).forEach(function (model) {
          options.push({
            value: provider.id + "::" + model.id,
            label: (provider.name || provider.id) + " · " + (model.name || model.id),
          });
        });
      });
      var save = function (value) {
        setInfo(function (previous) {
          return Object.assign({}, previous, { saving: true, message: "" });
        });
        var parts = String(value || "").split("::");
        hubFetch("/hub/model", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ provider: parts[0] || "", model: parts[1] || "" }),
        })
          .then(function (body) {
            if (!body.ok) {
              setInfo(function (previous) {
                return Object.assign({}, previous, { saving: false, message: body.error || "保存失败" });
              });
              return;
            }
            load();
          })
          .catch(function (error) {
            setInfo(function (previous) {
              return Object.assign({}, previous, { saving: false, message: hubErrorText(error) });
            });
          });
      };
      var statusText = !info.data
        ? (info.loading ? "读取中…" : info.message || "模型信息不可用")
        : available
          ? selected
            ? "可用"
            : "跟随 DSH 默认"
          : "不可用：" + (info.data.reason || (selected ? selected.provider + "/" + selected.model : ""));
      return h(
        "div",
        {
          "data-wallstreet-hub-model-bar": "",
          style: {
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            fontSize: 11.5,
            padding: "2px 0 6px",
          },
        },
        h("span", { style: { fontWeight: 600 } }, "AI 模型"),
        h(
          "select",
          {
            "data-wallstreet-hub-model-select": "",
            value: current,
            disabled: providers.length === 0,
            onChange: function (event) {
              save(event.target.value);
            },
            title: "摘要与研究的模型；从 DSH 模型列表选择，选完立即记住",
            style: {
              font: "inherit",
              fontSize: 11.5,
              padding: "3px 6px",
              borderRadius: 6,
              border: "1px solid " + COLORS.border,
              background: COLORS.chip,
              maxWidth: 300,
            },
          },
          options.map(function (option) {
            return h("option", { key: option.value, value: option.value }, option.label);
          })
        ),
        h(
          "span",
          { style: { color: available ? COLORS.faint : COLORS.down, fontSize: 11 } },
          statusText
        ),
        info.saving ? h("span", { style: { fontSize: 11, color: COLORS.muted } }, "保存中…") : null,
        info.message ? h("span", { style: { fontSize: 11, color: COLORS.down } }, info.message) : null
      );
    }

    /**
     * 源健康度卡：`/hub/stats` 的 `bySource` 逐行展示（源名 / 入库条数 / 最近成功 / 最近失败）。
     * 时间戳是 epoch ms（不是 ISO），所以走 hubStampText 而不是 timeText。
     */
    function HubSourceHealth(props) {
      var body = props.body;
      var bySource = body && Array.isArray(body.bySource) ? body.bySource : [];
      // 成分股缓存：徽标显示「精确 / 关键词」口径的直接原因，放一行让用户看得见。
      var membership = body && body.membership ? body.membership : null;
      var membershipNote = null;
      if (membership && isNum(membership.boardsWithMembers)) {
        membershipNote =
          "成分股 " +
          membership.boardsWithMembers +
          " 个板块" +
          (isNum(membership.memberCodes) ? " / " + membership.memberCodes + " 只" : "") +
          (isNum(membership.pending) && membership.pending > 0 ? " · 待补 " + membership.pending : "");
      }
      var failedCount = 0;
      var header = h(
        "div",
        {
          style: {
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.1fr) 64px 92px minmax(0, 1.5fr)",
            gap: 8,
            fontSize: 11,
            color: COLORS.faint,
            padding: "0 0 4px",
          },
        },
        h("span", null, "数据源"),
        h("span", { style: { textAlign: "right" } }, "入库条数"),
        h("span", null, "最近成功"),
        h("span", null, "最近失败"),
      );
      var rows = bySource.map(function (source) {
        var failed = !!source.lastError;
        if (failed) failedCount += 1;
        return h(
          "div",
          {
            key: source.id || source.label,
            "data-wallstreet-source-health": source.id || source.label || "",
            style: {
              display: "grid",
              gridTemplateColumns: "minmax(0, 1.1fr) 64px 92px minmax(0, 1.5fr)",
              gap: 8,
              alignItems: "baseline",
              fontSize: 12,
              padding: "3px 0",
              borderTop: "1px solid " + COLORS.border,
            },
          },
          h(
            "span",
            { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            h("span", { style: { color: COLORS.muted, fontSize: 11, marginRight: 5 } }, source.id || ""),
            source.label || source.id || "未知源",
          ),
          h(
            "span",
            {
              style: {
                textAlign: "right",
                fontFamily: NUM_FONT,
                fontVariantNumeric: "tabular-nums",
                color: isNum(source.count) && source.count > 0 ? "inherit" : COLORS.faint,
              },
            },
            hubCountText(source.count),
          ),
          h(
            "span",
            {
              title: source.lastOk ? new Date(source.lastOk).toLocaleString("zh-CN", { hour12: false }) : "从未成功",
              style: { fontFamily: NUM_FONT, fontSize: 11.5, color: COLORS.muted, whiteSpace: "nowrap" },
            },
            hubStampText(source.lastOk),
          ),
          failed
            ? h(
                "span",
                {
                  title: String(source.lastError || ""),
                  style: {
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: COLORS.down,
                    fontSize: 11.5,
                  },
                },
                source.lastError + (isNum(source.lastErrorAt) && source.lastErrorAt > 0 ? " · " + hubStampText(source.lastErrorAt) : ""),
              )
            : h("span", { style: { color: COLORS.faint, fontSize: 11.5 } }, "—"),
        );
      });

      var head = h(
        "div",
        { style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 } },
        h("span", { style: { fontSize: 12.5, fontWeight: 600 } }, "数据源健康度"),
        h(
          "span",
          { style: { fontSize: 11.5, color: COLORS.muted } },
          bySource.length ? "共 " + bySource.length + " 个源" + (failedCount ? " · " + failedCount + " 个最近失败" : " · 全部正常") : "",
        ),
        membershipNote ? h("span", { style: { fontSize: 11.5, color: COLORS.faint } }, membershipNote) : null,
        h("span", { style: { flex: 1 } }),
        props.loading ? h("span", { style: { fontSize: 11.5, color: COLORS.faint } }, "读取中…") : null,
        props.onConfig
          ? h(
              "button",
              {
                type: "button",
                "data-wallstreet-source-config-open": "",
                onClick: props.onConfig,
                style: {
                  font: "inherit",
                  fontSize: 11.5,
                  padding: "2px 9px",
                  borderRadius: 999,
                  border: "1px solid " + COLORS.border,
                  background: props.configOpen ? COLORS.chip : "transparent",
                  color: "inherit",
                  cursor: "pointer",
                },
              },
              props.configOpen ? "收起配置" : "配置源",
            )
          : null,
      );

      var content;
      if (props.error) {
        content = h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "2px 0" } },
          h("span", { style: { fontSize: 12.5, color: COLORS.down } }, "源状态读取失败"),
          props.errorDetail ? h("span", { style: { fontSize: 11.5, color: COLORS.muted } }, props.errorDetail) : null,
          h(
            ToolbarButton,
            { action: "hub-sources-retry", onClick: props.onRetry, title: "重新读取源状态" },
            "重试",
          ),
        );
      } else if (!bySource.length) {
        content = h("div", { style: { fontSize: 12.5, color: COLORS.muted } }, props.loading ? "正在读取源状态…" : "还没有源运行记录");
      } else {
        content = h("div", null, header, rows);
      }

      return h(
        "div",
        {
          "data-wallstreet-source-health-card": "",
          style: {
            border: "1px solid " + COLORS.border,
            borderRadius: 12,
            padding: "10px 14px",
            background: "color-mix(in srgb, currentColor 2.5%, transparent)",
          },
        },
        head,
        content,
      );
    }

    /**
     * 资讯 view：多源抓取 → 归一化 → 聚簇后的事件流，数据全部来自 `/wallstreet/api/hub/*`。
     * 60s 轮询，页面隐藏时暂停；后端没部署时只显示错误态，不白屏、不抛未捕获异常。
     */
    function NewsHub(props) {
      var filterState = react.useState(function () {
        // 从盘面点板块进资讯时，板块名 + 板块代码一起作为初始筛选：
        // 有 code 后端能直接按成分股精确过滤，没有就退回关键词。
        return {
          kind: "",
          q: "",
          ticker: "",
          sector: props.initialSector || "",
          sectorCode: props.initialSectorCode || "",
        };
      });
      var filters = filterState[0];
      var setFilters = filterState[1];
      var feedState = react.useState({ loading: true, data: null, error: "" });
      var feed = feedState[0];
      var setFeed = feedState[1];
      var syncState = react.useState({ running: false, message: "", error: "" });
      var sync = syncState[0];
      var setSync = syncState[1];
      var expandedState = react.useState("");
      var expanded = expandedState[0];
      var setExpanded = expandedState[1];
      var healthState = react.useState({ open: false, loading: false, data: null, error: "", errorDetail: "" });
      var configState = react.useState({ open: false, loading: false, data: null, error: "", draft: {}, saving: false, message: "" });
      var health = healthState[0];
      var setHealth = healthState[1];
      var frontpageState = react.useState({ collapsed: false, loading: false, data: null, error: "", digesting: false, digestMessage: "" });
      var frontpage = frontpageState[0];
      var setFrontpage = frontpageState[1];
      var sourceConfigState = configState;
      var sourceConfig = sourceConfigState[0];
      var setSourceConfig = sourceConfigState[1];
      var filtersRef = react.useRef(filters);
      filtersRef.current = filters;
      var aliveRef = react.useRef(true);
      var requestRef = react.useRef(0);
      var debounceRef = react.useRef(0);
      var healthRequestRef = react.useRef(0);
      var healthOpenRef = react.useRef(false);
      healthOpenRef.current = !!health.open;
      // 记下已经应用过的盘面板块 seq：同一个板块重复点（seq 变）时也要重新应用一次。
      var sectorSeqRef = react.useRef(props.initialSector ? (isNum(props.initialSectorSeq) ? props.initialSectorSeq : 0) : -1);
      var onMetaRef = react.useRef(props.onMeta);
      onMetaRef.current = props.onMeta;
      var onClearInitialSectorRef = react.useRef(props.onClearInitialSector);
      onClearInitialSectorRef.current = props.onClearInitialSector;

      var load = react.useCallback(function (next) {
        var current = next || filtersRef.current;
        var seq = ++requestRef.current;
        var params = ["limit=60"];
        if (current.kind) params.push("kind=" + encodeURIComponent(current.kind));
        if (current.q && current.q.trim()) params.push("q=" + encodeURIComponent(current.q.trim()));
        if (current.ticker && current.ticker.trim()) params.push("ticker=" + encodeURIComponent(current.ticker.trim()));
        if (current.sector && current.sector.trim()) params.push("sector=" + encodeURIComponent(current.sector.trim()));
        if (current.sectorCode && /^BK\d+$/.test(String(current.sectorCode))) {
          params.push("sectorCode=" + encodeURIComponent(String(current.sectorCode)));
        }
        setFeed(function (previous) {
          // 只有首次（还没有数据）才切「加载中」；后台轮询静默刷新，别让工具栏按钮一直闪「刷新中…」。
          return { loading: !previous.data, data: previous.data, error: "" };
        });
        hubFetch("/hub/feed?" + params.join("&"))
          .then(function (body) {
            if (!aliveRef.current || seq !== requestRef.current) return;
            setFeed({ loading: false, data: body, error: "" });
          })
          .catch(function (error) {
            if (!aliveRef.current || seq !== requestRef.current) return;
            setFeed(function (previous) {
              return { loading: false, data: previous.data, error: hubErrorText(error) };
            });
          });
      }, []);

      /** 自己写的最小防抖：筛选改动后 250ms 内只发一次请求（仍满足 300ms 内重拉）。 */
      var scheduleLoad = function (next, delay) {
        if (debounceRef.current) window.clearTimeout(debounceRef.current);
        debounceRef.current = window.setTimeout(function () {
          debounceRef.current = 0;
          load(next);
        }, delay);
      };

      react.useEffect(
        function () {
          aliveRef.current = true;
          load();
          loadFrontpage();
          var timer = window.setInterval(function () {
            // 页面隐藏时暂停轮询；切回前台后最多等一个周期就恢复。
            if (document.visibilityState === "hidden") return;
            load();
          }, 60_000);
          return function () {
            aliveRef.current = false;
            window.clearInterval(timer);
            if (debounceRef.current) window.clearTimeout(debounceRef.current);
            debounceRef.current = 0;
          };
        },
        [load],
      );

      react.useEffect(
        function () {
          if (props.registerReload) {
            props.registerReload(function () {
              load();
            });
          }
        },
        [load],
      );

      /** 盘面点板块进来后，seq 变化时把板块名落到筛选上；首次挂载已由 useState 初始化，不重复拉。 */
      react.useEffect(
        function () {
          var name = props.initialSector || "";
          var seq = isNum(props.initialSectorSeq) ? props.initialSectorSeq : 0;
          if (!name) return;
          if (sectorSeqRef.current === seq) return;
          sectorSeqRef.current = seq;
          var next = Object.assign({}, filtersRef.current, { sector: name });
          setFilters(next);
          scheduleLoad(next, 0);
        },
        [props.initialSector, props.initialSectorSeq],
      );

      react.useEffect(
        function () {
          if (!onMetaRef.current) return;
          var data = feed.data;
          var stats = (data && data.stats) || {};
          onMetaRef.current({
            loading: !!feed.loading,
            fetchedAt: data ? data.fetchedAt || "" : "",
            lastIngestAt: stats.lastIngestAt || "",
          });
        },
        [feed.loading, feed.data],
      );

      /** 源健康度：展开时读一次 `/hub/stats`；失败只落在卡片里，主列表照常。 */
      /**
       * 今日头版：挂载时取一次；点「刷新头版」或同步成功后重取。
       * 失败静默（头版是锦上添花，不该挡住主列表）。
       */
      var loadFrontpage = function () {
        setFrontpage(function (previous) {
          return Object.assign({}, previous, { loading: true, error: "" });
        });
        hubFetch("/hub/frontpage")
          .then(function (body) {
            if (!aliveRef.current) return;
            setFrontpage(function (previous) {
              return Object.assign({}, previous, { loading: false, data: body.frontpage || null, error: "" });
            });
          })
          .catch(function (error) {
            if (!aliveRef.current) return;
            setFrontpage(function (previous) {
              return Object.assign({}, previous, { loading: false, error: hubErrorText(error) });
            });
          });
      };

      /**
       * 导出当天日报：POST /hub/digest，后端写 data/digest/YYYY-MM-DD.md。
       * 成功后把路径/大小回显在头版卡上，用户知道去哪儿找。
       */
      var exportDigest = function () {
        setFrontpage(function (previous) {
          return Object.assign({}, previous, { digesting: true, digestMessage: "" });
        });
        hubFetch("/hub/digest", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: "{}",
        })
          .then(function (body) {
            if (!aliveRef.current) return;
            var kb = body.bytes ? (body.bytes / 1024).toFixed(1) + " KB" : "";
            setFrontpage(function (previous) {
              return Object.assign({}, previous, {
                digesting: false,
                digestMessage: body.ok
                  ? "日报已生成：" + body.path + (kb ? "（" + kb + "，" + body.events + " 条事件）" : "")
                  : "日报生成失败：" + (body.error || "未知原因"),
              });
            });
          })
          .catch(function (error) {
            if (!aliveRef.current) return;
            setFrontpage(function (previous) {
              return Object.assign({}, previous, { digesting: false, digestMessage: "日报生成失败：" + hubErrorText(error) });
            });
          });
      };

      /** 把当天日报投喂进知识库（后端调 scripts/kb/kb_publish.py，失败只回显不抛）。 */
      var publishDigest = function () {
        setFrontpage(function (previous) {
          return Object.assign({}, previous, { publishing: true, digestMessage: "" });
        });
        hubFetch("/hub/digest", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ publish: true }),
        })
          .then(function (body) {
            if (!aliveRef.current) return;
            var published = body.published || {};
            setFrontpage(function (previous) {
              return Object.assign({}, previous, {
                publishing: false,
                digestMessage: published.ok
                  ? "已发布到知识库：" + (published.url || published.uid || "ok")
                  : "发布失败：" + (published.error || "未知原因") + "（日报文件已生成：" + body.path + "）",
              });
            });
          })
          .catch(function (error) {
            if (!aliveRef.current) return;
            setFrontpage(function (previous) {
              return Object.assign({}, previous, { publishing: false, digestMessage: "发布失败：" + hubErrorText(error) });
            });
          });
      };

      var loadHealth = function () {
        var seq = ++healthRequestRef.current;
        setHealth(function (previous) {
          return { open: true, loading: !previous.data, data: previous.data, error: "", errorDetail: "" };
        });
        hubFetch("/hub/stats")
          .then(function (body) {
            if (!aliveRef.current || seq !== healthRequestRef.current) return;
            setHealth({ open: true, loading: false, data: body, error: "", errorDetail: "" });
          })
          .catch(function (error) {
            if (!aliveRef.current || seq !== healthRequestRef.current) return;
            setHealth(function (previous) {
              return {
                open: true,
                loading: false,
                data: previous.data,
                error: "源状态读取失败",
                errorDetail: hubErrorText(error),
              };
            });
          });
      };

      var toggleHealth = function () {
        if (health.open) {
          setHealth(function (previous) {
            return Object.assign({}, previous, { open: false });
          });
          return;
        }
        loadHealth();
      };

      var runSync = function () {
        if (sync.running) return;
        if (debounceRef.current) {
          window.clearTimeout(debounceRef.current);
          debounceRef.current = 0;
        }
        setSync({ running: true, message: "", error: "" });
        var controller = typeof AbortController === "function" ? new AbortController() : null;
        var abortTimer = controller
          ? window.setTimeout(function () {
              controller.abort();
            }, 45000)
          : 0;
        hubFetch("/hub/sync", { method: "POST", signal: controller ? controller.signal : undefined })
          .then(function (body) {
            if (abortTimer) window.clearTimeout(abortTimer);
            if (!aliveRef.current) return;
            var sources = Array.isArray(body.sources) ? body.sources : [];
            var failed = sources.filter(function (source) {
              return source && source.ok === false;
            }).length;
            setSync({
              running: false,
              message:
                (isNum(body.ingested) ? "已入库 " + body.ingested + " 条" : "同步完成") +
                (isNum(body.elapsedMs) ? " · " + (body.elapsedMs / 1000).toFixed(1) + "s" : "") +
                (failed ? " · " + failed + " 个源失败" : ""),
              error: "",
            });
            load();
            // 卡片展开着就顺手刷新一次源健康度，否则用户看到的还是同步前的旧状态。
            if (healthOpenRef.current) loadHealth();
          })
          .catch(function (error) {
            if (abortTimer) window.clearTimeout(abortTimer);
            if (!aliveRef.current) return;
            var aborted = error && error.name === "AbortError";
            setSync({
              running: false,
              message: "",
              error: aborted ? "同步超时（45 秒），稍后再试" : hubErrorText(error),
            });
          });
      };

      var clearFilters = function () {
        var next = { kind: "", q: "", ticker: "", sector: "", sectorCode: "" };
        setFilters(next);
        scheduleLoad(next, 0);
        // 「来自盘面」的板块也是筛选的一部分，清除时一并把 Dashboard 侧的来源标记复位。
        if (onClearInitialSectorRef.current) onClearInitialSectorRef.current();
      };

      /**
       * 源配置：打开时读 `/hub/config`，改动进 draft，保存时只提交改过的源。
       * 后端把覆盖值写进 `data/hub-settings.json`，下一轮入站自动应用（不用重载插件）。
       */
      var loadSourceConfig = function () {
        setSourceConfig(function (previous) {
          return Object.assign({}, previous, { open: true, loading: true, error: "", message: "" });
        });
        hubFetch("/hub/config")
          .then(function (body) {
            if (!aliveRef.current) return;
            return hubFetch("/hub/model").then(
              function (model) {
                if (!aliveRef.current) return;
                setSourceConfig({
                  open: true,
                  loading: false,
                  data: Object.assign({}, body, { model: model }),
                  error: body.error || "",
                  draft: {},
                  saving: false,
                  message: "",
                });
              },
              function () {
                if (!aliveRef.current) return;
                setSourceConfig({
                  open: true,
                  loading: false,
                  data: body,
                  error: body.error || "",
                  draft: {},
                  saving: false,
                  message: "",
                });
              }
            );
          })
          .catch(function (error) {
            if (!aliveRef.current) return;
            setSourceConfig(function (previous) {
              return Object.assign({}, previous, { open: true, loading: false, error: hubErrorText(error) });
            });
          });
      };

      var editSourceDraft = function (id, patch) {
        setSourceConfig(function (previous) {
          var draft = Object.assign({}, previous.draft);
          draft[id] = Object.assign({}, draft[id] || {}, patch);
          return Object.assign({}, previous, { draft: draft, message: "" });
        });
      };

      var saveModelSelection = function (provider, model) {
        setSourceConfig(function (previous) {
          return Object.assign({}, previous, { saving: true, message: "" });
        });
        hubFetch("/hub/model", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ provider: provider, model: model }),
        })
          .then(function (body) {
            if (!aliveRef.current) return;
            if (!body.ok) {
              setSourceConfig(function (previous) {
                return Object.assign({}, previous, { saving: false, message: body.error || "保存失败" });
              });
              return;
            }
            setSourceConfig(function (previous) {
              return Object.assign({}, previous, {
                saving: false,
                message: body.selected ? "模型已记住：" + body.selected.provider + "/" + body.selected.model : "已回到 DSH 默认模型",
                data: Object.assign({}, previous.data, {
                  model: Object.assign({}, body, { selected: body.selected || null }),
                }),
              });
            });
          })
          .catch(function (error) {
            if (!aliveRef.current) return;
            setSourceConfig(function (previous) {
              return Object.assign({}, previous, { saving: false, message: hubErrorText(error) });
            });
          });
      };

      var saveSourceConfig = function () {
        var ids = Object.keys(sourceConfig.draft || {});
        if (ids.length === 0) {
          setSourceConfig(function (previous) {
            return Object.assign({}, previous, { message: "没有改动" });
          });
          return;
        }
        var updates = ids.map(function (id) {
          return Object.assign({ id: id }, sourceConfig.draft[id]);
        });
        setSourceConfig(function (previous) {
          return Object.assign({}, previous, { saving: true, message: "" });
        });
        hubFetch("/hub/config", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ sources: updates }),
        })
          .then(function (body) {
            if (!aliveRef.current) return;
            setSourceConfig(function (previous) {
              return Object.assign({}, previous, {
                saving: false,
                data: Object.assign({}, previous.data, { sources: body.sources || [] }),
                draft: {},
                message: "已保存 " + updates.length + " 条改动，下一轮入站生效",
              });
            });
            loadHealth();
            load();
          })
          .catch(function (error) {
            if (!aliveRef.current) return;
            setSourceConfig(function (previous) {
              return Object.assign({}, previous, { saving: false, message: hubErrorText(error) });
            });
          });
      };

      var payload = feed.data;
      var events = payload && Array.isArray(payload.events) ? payload.events : [];
      var stats = (payload && payload.stats) || {};
      var hasFilters = !!(
        filters.kind ||
        (filters.q && filters.q.trim()) ||
        (filters.ticker && filters.ticker.trim()) ||
        (filters.sector && filters.sector.trim())
      );
      // 「来自盘面」只在板块筛选仍然等于盘面带入的那一项时显示；用户手动改过就按普通筛选处理。
      var originSector =
        props.initialSector && filters.sector && String(filters.sector).trim() === String(props.initialSector).trim()
          ? String(props.initialSector).trim()
          : "";

      // 契约 §6 的 stats 里没有「今日事件」；后端补了 todayEvents 就直读，否则按当前页事件现算并注明口径。
      var todayCount = isNum(stats.todayEvents) ? stats.todayEvents : isNum(stats.eventsToday) ? stats.eventsToday : null;
      var todayDerived = todayCount === null;
      if (todayDerived) {
        var startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        todayCount = 0;
        for (var eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
          if (isNum(events[eventIndex].ts) && events[eventIndex].ts >= startOfDay.getTime()) todayCount += 1;
        }
      }
      var itemsSub = [];
      if (isNum(stats.events)) itemsSub.push("事件 " + hubCountText(stats.events));
      if (isNum(stats.sources)) itemsSub.push(stats.sources + " 个源");

      var statBar = h(
        "div",
        {
          "data-wallstreet-news-stats": "",
          style: {
            display: "flex",
            alignItems: "center",
            gap: 18,
            flexWrap: "wrap",
            border: "1px solid " + COLORS.border,
            borderRadius: 12,
            padding: "10px 14px",
            background: "color-mix(in srgb, currentColor 2.5%, transparent)",
          },
        },
        h(Stat, {
          label: "今日事件",
          value: hubCountText(todayCount),
          sub: todayDerived ? "统计自当前页" : "全库",
        }),
        h(Stat, {
          label: "入库条目",
          value: hubCountText(stats.items),
          sub: itemsSub.join(" · "),
        }),
        h(Stat, {
          label: "最近同步",
          value: stats.lastIngestAt ? timeText(stats.lastIngestAt).slice(0, 5) : "—",
          sub: hubAgoText(stats.lastIngestAt),
        }),
        h("span", { style: { flex: 1 } }),
        sync.message ? h("span", { style: { fontSize: 11.5, color: COLORS.muted } }, sync.message) : null,
        h(
          ToolbarButton,
          {
            action: "hub-sources",
            onClick: toggleHealth,
            title: health.open ? "收起源健康度" : "展开各数据源最近一次成功 / 失败",
          },
          "数据源 " + (isNum(stats.sources) ? stats.sources : "—") + (health.open ? " ▲" : " ▼"),
        ),
        h(
          ToolbarButton,
          { action: "hub-sync", primary: true, onClick: runSync, disabled: sync.running, title: "立即跑一轮入站抓取" },
          sync.running ? "同步中…" : "立即同步",
        ),
      );

      var healthCard = health.open
        ? h(HubSourceHealth, {
            body: health.data,
            loading: !!health.loading,
            error: health.error,
            errorDetail: health.errorDetail,
            onRetry: loadHealth,
            onConfig: function () {
              if (sourceConfig.open) {
                setSourceConfig(function (previous) {
                  return Object.assign({}, previous, { open: false });
                });
              } else {
                loadSourceConfig();
              }
            },
            configOpen: !!sourceConfig.open,
          })
        : null;

      // 源配置卡：只在健康度卡展开且点了「配置源」时出现。
      var sourceConfigCard = sourceConfig.open
        ? h(HubSourceConfig, {
            data: sourceConfig.data,
            draft: sourceConfig.draft,
            saving: !!sourceConfig.saving,
            message: sourceConfig.message,
            error: sourceConfig.error,
            loading: !!sourceConfig.loading,
            onToggle: function (id, enabled) {
              editSourceDraft(id, { enabled: enabled });
            },
            onInterval: function (id, intervalMs) {
              editSourceDraft(id, { intervalMs: intervalMs });
            },
            onSave: saveSourceConfig,
            onModelSave: saveModelSelection,
            onClose: function () {
              setSourceConfig(function (previous) {
                return Object.assign({}, previous, { open: false });
              });
            },
          })
        : null;

      var filterRow = h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
        originSector
          ? h(
              "button",
              {
                type: "button",
                "data-wallstreet-news-sector-origin": originSector,
                title: "清除盘面带入的板块筛选",
                onClick: function () {
                  var next = Object.assign({}, filters, { sector: "", sectorCode: "" });
                  setFilters(next);
                  scheduleLoad(next, 0);
                  if (onClearInitialSectorRef.current) onClearInitialSectorRef.current();
                },
                style: {
                  font: "inherit",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "3px 10px",
                  borderRadius: 999,
                  fontSize: 11.5,
                  cursor: "pointer",
                  border: "1px solid " + COLORS.borderStrong,
                  background: COLORS.chip,
                  color: "inherit",
                  maxWidth: 260,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                },
              },
              "来自盘面：" + originSector,
              h("span", { style: { color: COLORS.muted, fontSize: 12 } }, "×"),
            )
          : null,
        h(
          "div",
          { style: { display: "inline-flex", gap: 4, flexWrap: "wrap" } },
          HUB_KIND_CHIPS.map(function (chip) {
            var on = filters.kind === chip.id;
            return h(
              "button",
              {
                key: chip.id || "all",
                type: "button",
                "data-wallstreet-news-kind": chip.id || "all",
                onClick: function () {
                  var next = Object.assign({}, filters, { kind: chip.id });
                  setFilters(next);
                  scheduleLoad(next, 0);
                },
                style: {
                  font: "inherit",
                  padding: "3px 10px",
                  borderRadius: 999,
                  fontSize: 11.5,
                  cursor: "pointer",
                  border: "1px solid " + (on ? COLORS.border : "transparent"),
                  background: on ? COLORS.chip : "transparent",
                  color: on ? "inherit" : COLORS.muted,
                },
              },
              chip.label,
            );
          }),
        ),
        h("input", {
          type: "search",
          value: filters.q,
          placeholder: "关键词：标题 / 摘要",
          "data-wallstreet-news-query": "",
          onChange: function (event) {
            var next = Object.assign({}, filters, { q: event.target.value });
            setFilters(next);
            scheduleLoad(next, 250);
          },
          style: {
            font: "inherit",
            flex: "1 1 160px",
            minWidth: 0,
            maxWidth: 240,
            padding: "5px 9px",
            borderRadius: 7,
            border: "1px solid " + COLORS.border,
            background: "transparent",
            color: "inherit",
            fontSize: 12.5,
          },
        }),
        h("input", {
          type: "search",
          value: filters.ticker,
          placeholder: "个股代码：600519",
          inputMode: "numeric",
          "data-wallstreet-news-ticker": "",
          onChange: function (event) {
            var next = Object.assign({}, filters, { ticker: event.target.value });
            setFilters(next);
            scheduleLoad(next, 250);
          },
          style: {
            font: "inherit",
            flex: "0 1 150px",
            minWidth: 0,
            padding: "5px 9px",
            borderRadius: 7,
            border: "1px solid " + COLORS.border,
            background: "transparent",
            color: "inherit",
            fontSize: 12.5,
          },
        }),
        h("input", {
          type: "search",
          value: filters.sector,
          placeholder: "板块：如 半导体",
          "data-wallstreet-news-sector": "",
          onChange: function (event) {
            // 手输板块名说明不看盘面那一个了，把盘面带的板块代码丢掉，回到关键词口径。
            var next = Object.assign({}, filters, { sector: event.target.value, sectorCode: "" });
            setFilters(next);
            scheduleLoad(next, 250);
          },
          style: {
            font: "inherit",
            flex: "0 1 150px",
            minWidth: 0,
            padding: "5px 9px",
            borderRadius: 7,
            border: "1px solid " + COLORS.border,
            background: "transparent",
            color: "inherit",
            fontSize: 12.5,
          },
        }),
        hasFilters ? h(ToolbarButton, { action: "news-clear", onClick: clearFilters }, "清除筛选") : null,
        h("span", { style: { flex: 1 } }),
        payload
          ? h(
              "span",
              { style: { fontSize: 11.5, color: COLORS.muted, fontVariantNumeric: "tabular-nums" } },
              "匹配 " + hubCountText(payload.total) + " · 显示 " + events.length,
            )
          : null,
      );

      var staleError =
        payload && feed.error
          ? h("div", { style: { fontSize: 12, color: COLORS.down } }, feed.error + "（显示的是上一次成功的数据）")
          : null;

      var listBlock;
      if (!payload && feed.loading) {
        listBlock = h("div", { style: { padding: "14px 0", fontSize: 12.5, color: COLORS.muted } }, "正在拉取资讯事件…");
      } else if (!payload && feed.error) {
        listBlock = h(
          "div",
          { style: { padding: "14px 0", fontSize: 13 } },
          h("div", { style: { color: COLORS.muted, marginBottom: 8 } }, feed.error),
          h(
            ToolbarButton,
            {
              action: "news-retry",
              primary: true,
              onClick: function () {
                load();
              },
            },
            "重试",
          ),
        );
      } else if (!events.length) {
        listBlock = h(
          EmptyHint,
          null,
          hasFilters ? "没有匹配的资讯事件，换个关键词或点「清除筛选」" : "库里还没有资讯事件，点「立即同步」跑一轮入站",
        );
      } else {
        listBlock = h(
          "div",
          { style: { display: "flex", flexDirection: "column" } },
          events.map(function (event, index) {
            var rowId = event && event.id ? String(event.id) : "row-" + index;
            return h(NewsEventRow, {
              key: rowId,
              event: event,
              expanded: expanded === rowId,
              onToggle: function () {
                setExpanded(expanded === rowId ? "" : rowId);
              },
            });
          }),
        );
      }

      return h(
        "div",
        {
          "data-dsh-wallstreet-news": "",
          style: {
            padding: "12px 16px 26px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            overflowY: "auto",
            minHeight: 0,
            flex: 1,
          },
        },
        statBar,
        h(HubFrontpage, {
          data: frontpage.data,
          error: frontpage.error,
          refreshing: !!frontpage.loading,
          collapsed: !!frontpage.collapsed,
          compact: !!props.compact,
          onRefresh: loadFrontpage,
          onDigest: exportDigest,
          onPublish: publishDigest,
          publishing: !!frontpage.publishing,
          digesting: !!frontpage.digesting,
          digestMessage: frontpage.digestMessage,
          onToggle: function () {
            setFrontpage(function (previous) {
              return Object.assign({}, previous, { collapsed: !previous.collapsed });
            });
          },
        }),
        h(HubModelBar),
        healthCard,
        sourceConfigCard,
        sync.error ? h("div", { style: { fontSize: 12, color: COLORS.down } }, sync.error) : null,
        filterRow,
        staleError,
        listBlock,
        h(
          "div",
          { style: { fontSize: 11.5, color: COLORS.faint, lineHeight: 1.7, paddingTop: 2 } },
          "资讯来自新浪财经、华尔街见闻、巨潮公告、东财公告/研报、国务院政策等公开源；同事件多源聚簇，「N 家」表示有 N 个源报道，重要度由规则打分（≥70 标红）。点开一条可看簇内各源原文链接。",
          h("br"),
          "仅供研究参考，不构成投资建议。",
        ),
      );
    }

    /* ------------------------------ 主面板 ------------------------------ */

    function StatusBadge(props) {
      var trading = props.trading || {};
      var session = trading.session || "closed";
      var labels = {
        trading: "交易中",
        lunch: "午间休市",
        closing: "已收盘",
        preopen: "未开盘",
        closed: "已收盘",
      };
      var color = session === "trading" ? COLORS.up : COLORS.muted;
      return h(
        "span",
        { style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: COLORS.muted } },
        h("span", {
          style: {
            width: 7,
            height: 7,
            borderRadius: 999,
            background: color,
            boxShadow: session === "trading" ? "0 0 0 3px color-mix(in srgb, " + COLORS.up + " 18%, transparent)" : "none",
          },
        }),
        labels[session] || "—",
        trading.date ? h("span", null, trading.date) : null,
      );
    }

    function ToolbarButton(props) {
      return h(
        "button",
        {
          type: "button",
          onClick: props.onClick,
          disabled: !!props.disabled,
          title: props.title || "",
          "data-dsh-wallstreet-action": props.action || "",
          style: {
            padding: "5px 12px",
            borderRadius: 7,
            border: "1px solid " + COLORS.border,
            background: props.primary ? "color-mix(in srgb, currentColor 10%, transparent)" : "transparent",
            color: "inherit",
            font: "inherit",
            fontSize: 12.5,
            cursor: props.disabled ? "default" : "pointer",
            opacity: props.disabled ? 0.5 : 1,
            whiteSpace: "nowrap",
          },
        },
        props.children,
      );
    }

    /* ------------------------------ 策略视图（迁移自 vectra 口径） ------------------------------ */

    var PROFILE_OPTIONS = [
      { id: "10w", label: "10 万本金" },
      { id: "50w", label: "50 万本金" },
    ];

    var LOSS_KIND_LABELS = {
      stock: "个股",
      sectorETF: "行业 ETF",
      broadETF: "宽基 ETF",
      convertible: "可转债",
    };

    var INPUT_STYLE = {
      padding: "4px 8px",
      fontSize: 12.5,
      borderRadius: 7,
      border: "1px solid " + COLORS.border,
      background: "transparent",
      color: "inherit",
      font: "inherit",
      width: 138,
    };

    function fmtPct(value, digits) {
      var number = Number(value);
      if (!Number.isFinite(number)) return "—";
      return (number * 100).toFixed(digits == null ? 1 : digits) + "%";
    }

    function fmtWan(value) {
      var number = Number(value);
      if (!Number.isFinite(number) || number <= 0) return "—";
      return (number / 10000).toFixed(number % 10000 === 0 ? 0 : 1) + " 万";
    }

    function StrategyTable(props) {
      var cellStyle = {
        padding: "5px 8px",
        borderBottom: "1px solid " + COLORS.border,
        fontSize: 12.5,
        fontVariantNumeric: "tabular-nums",
      };
      return h(
        "table",
        { style: { width: "100%", borderCollapse: "collapse" } },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            props.head.map(function (label, index) {
              return h(
                "th",
                {
                  key: index,
                  style: Object.assign({}, cellStyle, {
                    textAlign: index === 0 ? "left" : "right",
                    color: COLORS.muted,
                    fontWeight: 500,
                    borderBottom: "1px solid " + COLORS.borderStrong,
                  }),
                },
                label,
              );
            }),
          ),
        ),
        h(
          "tbody",
          null,
          props.rows.map(function (row, rowIndex) {
            return h(
              "tr",
              { key: rowIndex },
              row.map(function (cell, cellIndex) {
                return h(
                  "td",
                  {
                    key: cellIndex,
                    style: Object.assign({}, cellStyle, {
                      textAlign: cellIndex === 0 ? "left" : "right",
                      whiteSpace: cellIndex === row.length - 1 && props.wideLast ? "normal" : "nowrap",
                    }),
                  },
                  cell == null ? "—" : String(cell),
                );
              }),
            );
          }),
        ),
      );
    }

    function StrategyView(props) {
      var profileState = react.useState("10w");
      var profile = profileState[0];
      var setProfile = profileState[1];
      var detailState = react.useState({ loading: true, error: "", data: null });
      var detail = detailState[0];
      var setDetail = detailState[1];
      var gridInputState = react.useState({ last: "", capital: "" });
      var gridInput = gridInputState[0];
      var setGridInput = gridInputState[1];
      var gridState = react.useState({ loading: false, error: "", data: null });
      var grid = gridState[0];
      var setGrid = gridState[1];
      var onMetaRef = react.useRef(props.onMeta);
      onMetaRef.current = props.onMeta;

      var load = react.useCallback(
        function () {
          var alive = true;
          setDetail(function (prev) {
            return { loading: true, error: "", data: prev.data };
          });
          fetch(API + "/strategy/overview?profile=" + encodeURIComponent(profile), {
            headers: { accept: "application/json" },
            credentials: "same-origin",
          })
            .then(function (res) {
              if (!res.ok) throw new Error("HTTP " + res.status);
              return res.json();
            })
            .then(function (json) {
              if (!alive) return;
              if (!json || json.ok === false) throw new Error((json && json.error) || "口径接口返回异常");
              setDetail({ loading: false, error: "", data: json });
              if (onMetaRef.current) onMetaRef.current({ loading: false, fetchedAt: new Date().toISOString(), dataDate: json.profile || "" });
            })
            .catch(function (error) {
              if (!alive) return;
              setDetail({ loading: false, error: String((error && error.message) || error), data: null });
              if (onMetaRef.current) onMetaRef.current({ loading: false, fetchedAt: new Date().toISOString(), dataDate: "" });
            });
          return function () {
            alive = false;
          };
        },
        [profile],
      );

      react.useEffect(load, [load]);
      react.useEffect(
        function () {
          if (props.registerReload) props.registerReload(load);
        },
        [load, props.registerReload],
      );

      var runGrid = function () {
        var last = Number(gridInput.last);
        if (!(last > 0)) {
          setGrid({ loading: false, error: "先填一个当前价，比如 3.002", data: null });
          return;
        }
        var capital = Number(gridInput.capital);
        var query = "?last=" + encodeURIComponent(last);
        if (capital > 0) query += "&capital=" + encodeURIComponent(capital);
        setGrid({ loading: true, error: "", data: grid.data });
        fetch(API + "/strategy/grid" + query, { headers: { accept: "application/json" }, credentials: "same-origin" })
          .then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
          })
          .then(function (json) {
            if (!json || json.ok === false) throw new Error((json && json.error) || "网格接口返回异常");
            setGrid({ loading: false, error: "", data: json });
          })
          .catch(function (error) {
            setGrid({ loading: false, error: String((error && error.message) || error), data: null });
          });
      };

      var data = detail.data;
      if (!data) {
        return h(
          "div",
          { style: { padding: 28, fontSize: 13 } },
          detail.loading
            ? "正在读取策略口径…"
            : h("div", { style: { color: COLORS.down } }, detail.error || "策略口径为空"),
        );
      }

      var rules = data.rules || {};
      var valuation = rules.valuation;
      var circuit = rules.circuitBreaker || {};
      var pyramid = rules.pyramid || [];

      var profileSwitch = h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
        PROFILE_OPTIONS.map(function (option) {
          var active = option.id === data.profile;
          return h(
            "button",
            {
              key: option.id,
              type: "button",
              "data-dsh-wallstreet-profile": option.id,
              onClick: function () {
                setProfile(option.id);
              },
              style: {
                padding: "4px 12px",
                fontSize: 12.5,
                borderRadius: 999,
                border: "1px solid " + COLORS.border,
                background: active ? COLORS.chip : "transparent",
                color: "inherit",
                font: "inherit",
                cursor: "pointer",
              },
            },
            option.label,
          );
        }),
        h("span", { style: { fontSize: 11.5, color: COLORS.muted } }, data.label),
        h("span", { style: { flex: 1 } }),
        h(Tag, null, "组合目标年化 " + Number(data.blendedTarget).toFixed(1) + "%"),
        detail.loading ? h(Tag, null, "更新中…") : null,
      );

      var allocationRows = (data.rows || []).map(function (row) {
        return [row.label, Number(row.weightPct).toFixed(1) + "%", fmtWan(row.amount), (row.targetReturn * 100).toFixed(1) + "%", row.tools];
      });

      var ruleLines = [
        "单票上限 " + fmtPct(rules.singleStockMax, 0) + " · 单行业上限 " + fmtPct(rules.singleSectorMax, 0),
        "核心底仓下限 " + fmtPct(rules.coreMin, 0) + " · 现金下限 " + fmtPct(rules.cashMin, 0),
        "再平衡触发：偏离目标 " + fmtPct(rules.rebalanceDeviation, 0) + " 以上",
        "金字塔加仓：" +
          pyramid
            .map(function (part) {
              return (part * 100).toFixed(0) + "%";
            })
            .join(" / "),
        valuation
          ? "估值开关：沪深300 PE < " +
            valuation.lowPe +
            " 加仓核心至 " +
            fmtPct(valuation.lowPeCoreWeight, 0) +
            "，PE > " +
            valuation.highPe +
            " 减至 " +
            fmtPct(valuation.highPeCoreWeight, 0)
          : null,
        "年度熔断：" + fmtPct(circuit.pause, 0) + " 停手 1 个月 · " + fmtPct(circuit.liquidateSatellite, 0) + " 清仓卫星",
      ].filter(Boolean);

      var stopRows = (data.stopLoss || []).map(function (row) {
        return [
          LOSS_KIND_LABELS[row.kind] || row.kind,
          row.review == null ? "不止损" : fmtPct(row.review, 0) + " 评估",
          row.cut == null ? (row.review == null ? "不止损" : "只评估") : fmtPct(row.cut, 0) + " 强平",
        ];
      });

      var gridCard = h(
        "div",
        null,
        h(
          "div",
          { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
          h("input", {
            type: "number",
            step: "0.001",
            placeholder: "当前价（如 3.002）",
            value: gridInput.last,
            onChange: function (event) {
              setGridInput({ last: event.target.value, capital: gridInput.capital });
            },
            style: INPUT_STYLE,
          }),
          h("input", {
            type: "number",
            step: "1000",
            placeholder: "可用资金（可选）",
            value: gridInput.capital,
            onChange: function (event) {
              setGridInput({ last: gridInput.last, capital: event.target.value });
            },
            style: INPUT_STYLE,
          }),
          h(ToolbarButton, { action: "grid", onClick: runGrid, primary: true, disabled: grid.loading }, grid.loading ? "测算中…" : "测算网格"),
        ),
        grid.error ? h("div", { style: { marginTop: 8, fontSize: 12, color: COLORS.down } }, grid.error) : null,
        grid.data
          ? h(
              "div",
              { style: { marginTop: 10, display: "grid", gap: 8 } },
              h("div", { style: { fontSize: 12, color: COLORS.muted, lineHeight: 1.7 } }, grid.data.note),
              h(StrategyTable, {
                head: ["档位", "价格", "每档资金", "单格净收益"],
                rows: (grid.data.levels || []).map(function (level) {
                  return [
                    String(level.index + 1),
                    Number(level.price).toFixed(3),
                    fmtWan(level.amount),
                    grid.data.roundTrip ? grid.data.roundTrip.netPct + "%" : "—",
                  ];
                }),
              }),
            )
          : null,
      );

      return h(
        "div",
        { style: { padding: "14px 16px 40px", display: "flex", flexDirection: "column", gap: 12, overflowY: "auto", minHeight: 0, flex: 1 } },
        profileSwitch,
        h(
          SectionCard,
          { title: "资产配置", hint: "四桶结构 · 金额按本金折算" },
          h(StrategyTable, { head: ["桶", "权重", "金额", "目标收益", "工具"], rows: allocationRows, wideLast: true }),
        ),
        h(
          SectionCard,
          { title: "风控红线", hint: "来自 vectra 文档口径" },
          h(
            "ul",
            { style: { margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.9 } },
            ruleLines.map(function (line, index) {
              return h("li", { key: index }, line);
            }),
          ),
        ),
        h(SectionCard, { title: "止损分级", hint: "负值按成本价计算" }, h(StrategyTable, { head: ["类型", "预警", "处理"], rows: stopRows })),
        h(SectionCard, { title: "网格测算", hint: "默认区间 ±5%（vectra 总区间 10%）" }, gridCard),
        h(
          "div",
          { style: { fontSize: 11.5, color: COLORS.faint, lineHeight: 1.7 } },
          "口径来自 openclaw:/root/vectra 的《个人投资策略方案》与《10 万本金版》，已抽成纯函数 lib/strategy.js。面板只做测算与展示，不接券商、不下单，不构成投资建议。",
        ),
      );
    }

    function Dashboard(props) {
      var overview = useOverview();
      var data = overview.data;
      var viewState = react.useState("market");
      var view = viewState[0];
      var setView = viewState[1];
      var rootRef = react.useRef(null);
      var panelWidth = useElementWidth(rootRef);
      var shellCompact = useMediaQuery("(max-width: 959px)");
      var narrow = panelWidth > 0 && panelWidth < 860;
      var tight = panelWidth > 0 && panelWidth < 580;
      var emptyMeta = { loading: false, fetchedAt: "", dataDate: "" };
      var movesMetaState = react.useState(emptyMeta);
      var movesMeta = movesMetaState[0];
      var setMovesMeta = movesMetaState[1];
      var researchMetaState = react.useState(emptyMeta);
      var researchMeta = researchMetaState[0];
      var setResearchMeta = researchMetaState[1];
      var newsMetaState = react.useState(emptyMeta);
      var newsMeta = newsMetaState[0];
      var setNewsMeta = newsMetaState[1];
      var movesReloadRef = react.useRef(null);
      var researchReloadRef = react.useRef(null);
      var newsReloadRef = react.useRef(null);
      var strategyReloadRef = react.useRef(null);
      var strategyMetaState = react.useState(emptyMeta);
      var strategyMeta = strategyMetaState[0];
      var setStrategyMeta = strategyMetaState[1];
      var stockState = react.useState(null);
      var selectedStock = stockState[0];
      var setSelectedStock = stockState[1];
      // 盘面「板块轮动」→ 资讯：{ sector, seq }，seq 递增保证重复点同一个板块也能重新应用筛选。
      var sectorPickState = react.useState(null);
      var sectorPick = sectorPickState[0];
      var setSectorPick = sectorPickState[1];
      var pickSector = function (name, code) {
        var sectorName = name ? String(name).trim() : "";
        if (!sectorName) return;
        var sectorCode = code && /^BK\d+$/.test(String(code)) ? String(code) : "";
        setSectorPick(function (previous) {
          return { sector: sectorName, code: sectorCode, seq: previous && isNum(previous.seq) ? previous.seq + 1 : 1 };
        });
        setView("news");
      };

      var activeMeta =
        view === "moves"
          ? movesMeta
          : view === "research"
            ? researchMeta
            : view === "strategy"
              ? strategyMeta
              : view === "news"
                ? newsMeta
                : null;
      var activeLoading = view === "market" ? !!overview.loading : !!(activeMeta && activeMeta.loading);

      var refresh = function () {
        if (view === "moves") {
          if (movesReloadRef.current) movesReloadRef.current();
          return;
        }
        if (view === "research") {
          if (researchReloadRef.current) researchReloadRef.current();
          return;
        }
        if (view === "strategy") {
          if (strategyReloadRef.current) strategyReloadRef.current();
          return;
        }
        if (view === "news") {
          if (newsReloadRef.current) newsReloadRef.current();
          return;
        }
        overview.reload();
      };
      var backToConversation = function () {
        try {
          if (props.selectConversation) props.selectConversation();
        } catch (error) {
          console.warn("[dsh-wallstreet] 返回对话失败:", error);
        }
      };

      var freshness;
      if (view === "market") {
        freshness = data
          ? data.dataMode === "live"
            ? "盘中实时 · " + (data.dataTime || "刚刚") + " 更新"
            : "收盘快照 · " + (data.marketDate || "") + " " + (data.dataTime || "")
          : "加载中…";
      } else if (view === "moves") {
        freshness = movesMeta.loading
          ? "读取中…"
          : movesMeta.fetchedAt
            ? movesMeta.dataMode === "live"
              ? "盘中实时 · " + (movesMeta.dataTime || "刚刚") + " 更新"
              : "收盘快照 · " + (movesMeta.dataDate || movesMeta.fetchedAt.slice(0, 10))
            : "—";
      } else if (view === "research") {
        freshness = researchMeta.loading
          ? "读取中…"
          : researchMeta.fetchedAt
            ? "归档 " + researchMeta.fetchedAt.slice(0, 16)
            : "—";
      } else if (view === "news") {
        freshness = newsMeta.loading
          ? "同步中…"
          : newsMeta.lastIngestAt
            ? "同步 " + timeText(newsMeta.lastIngestAt).slice(0, 5)
            : newsMeta.fetchedAt
              ? "未同步"
              : "—";
      } else {
        freshness = strategyMeta.loading ? "读取中…" : strategyMeta.fetchedAt ? "口径就绪 · " + strategyMeta.fetchedAt.slice(11, 16) : "—";
      }

      var subtitles = {
        market: data && data.dataMode === "live" ? "今日盘面 · 盘中实时" : "今日盘面 · 收盘快照",
        moves: movesMeta.dataMode === "live" ? "个股与资金异动 · 盘中实时" : "个股与资金异动 · 收盘快照",
        news: "多源资讯事件流 · 自动同步",
        research: "研究结论与慢数据 · 只读归档",
        strategy: "策略口径 · 只做测算，不下单",
      };

      var toolbar = h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: shellCompact ? "10px 16px 10px 52px" : "10px 16px",
            borderBottom: "1px solid " + COLORS.border,
            flexShrink: 0,
            flexWrap: "wrap",
          },
        },
        h("span", { style: { fontSize: 14, fontWeight: 700, letterSpacing: 0.2 } }, "华尔街之狼"),
        h(TabBar, {
          active: view,
          onChange: setView,
          tabs: [
            { id: "market", label: "盘面" },
            { id: "moves", label: "异动" },
            { id: "news", label: "资讯" },
            { id: "research", label: "研究" },
            { id: "strategy", label: "策略" },
          ],
        }),
        tight ? null : h("span", { style: { fontSize: 12, color: COLORS.muted } }, subtitles[view] || ""),
        h("span", { style: { flex: 1 } }),
        h(StatusBadge, { trading: data ? data.trading : null }),
        h(
          "span",
          {
            "data-dsh-wallstreet-freshness": "",
            title: (function () {
              var parts = data && Array.isArray(data.parts) ? data.parts : [];
              if (parts.length === 0) return "";
              // 每个分区的耗时/错误码：面板上不铺开，hover 能看就够。
              return parts
                .map(function (part) {
                  return part.id + " " + (part.ok ? (part.stale ? "缓存" : "ok") : part.error || "失败") + " " + part.ms + "ms";
                })
                .join("\n");
            })(),
            style: { fontSize: 11.5, color: COLORS.muted, fontVariantNumeric: "tabular-nums" },
          },
          freshness,
        ),
        data && data.partsStale ? h(Tag, null, "部分缓存") : null,
        h(
          ToolbarButton,
          { action: "refresh", onClick: refresh, disabled: activeLoading, primary: true },
          activeLoading ? "刷新中…" : "刷新",
        ),
        h(ToolbarButton, { action: "back", onClick: backToConversation, title: "回到对话" }, "返回对话"),
      );

      var body = null;

      if (view === "market") {
        if (!data && overview.loading) {
          body = h(
            "div",
            { style: { padding: 28, color: COLORS.muted, fontSize: 13 } },
            "正在读取收盘快照与实时行情…",
          );
        } else if (!data && overview.error) {
          body = h(
            "div",
            { style: { padding: 28, fontSize: 13 } },
            h("div", { style: { color: COLORS.down, marginBottom: 8 } }, overview.error),
            h(ToolbarButton, { action: "retry", onClick: refresh, primary: true }, "重试"),
          );
        } else {
          var sections = [];
          sections.push(h(BriefingBar, {
                key: "briefing",
                summary: data.summary,
                stale: data.stale,
                live: data.dataMode === "live",
              }));
          sections.push(
            h(
              SectionCard,
              {
                key: "indices",
                id: "indices",
                title: "全球指数",
                hint: "A 股 · 港股 · 美股（腾讯行情）",
                extra:
                  data.indices && data.indices.length
                    ? h(
                        "div",
                        { style: { display: "flex", gap: 6, alignItems: "center" } },
                        h(Tag, null, "实时"),
                        h(Tag, null, "成交额口径：人民币"),
                      )
                    : null,
              },
              h(IndexGrid, { indices: data.indices, trend: data.trend, panelWidth: panelWidth }),
            ),
          );
          sections.push(
            h(
              "div",
              {
                key: "charts",
                style: {
                  display: "grid",
                  gridTemplateColumns: narrow ? "minmax(0, 1fr)" : "minmax(0, 1.55fr) minmax(260px, 1fr)",
                  gap: 12,
                },
              },
              h(
                SectionCard,
                { title: "上证指数 · 分时", hint: "价格 / 均价 / 昨收（腾讯行情）" },
                h(TrendChart, { trend: data.trend ? data.trend.sh : null }),
              ),
              h(
                SectionCard,
                {
                  title: "市场温度",
                  hint: "0–100",
                  extra: h(Tag, null, data.dataMode === "live" && data.sources && data.sources.breadth === "live" ? "盘中实时" : "收盘快照"),
                },
                h(TemperatureCard, { analysis: data.analysis }),
              ),
            ),
          );
          sections.push(
            h(
              "div",
              {
                key: "breadth-sectors",
                style: { display: "grid", gridTemplateColumns: narrow ? "minmax(0, 1fr)" : "minmax(0, 1fr) minmax(0, 1.5fr)", gap: 12 },
              },
              h(
                SectionCard,
                {
                  title: "市场宽度",
                  hint: "涨跌家数",
                  extra: h(
                    "div",
                    { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
                    h(Tag, null, data.dataMode === "live" && data.sources && data.sources.breadth === "live" ? "盘中实时" : "收盘快照"),
                    data.turnover ? h(Tag, null, "两市成交 " + yi(data.turnover.total)) : null,
                    data.dataMode === "live" && data.turnover && isNum(data.turnover.projectedTotal)
                      ? h(Tag, null, "预计全天 " + yi(data.turnover.projectedTotal))
                      : null,
                  ),
                },
                h(BreadthCard, { breadth: data.breadth, compact: tight }),
              ),
              h(
                SectionCard,
                {
                  title: "板块轮动",
                  hint:
                    (data.dataMode === "live" ? "东财实时行业板块 · 按涨跌幅" : "market-report 行业板块 · 按涨跌幅") +
                    " · 点行看资讯",
                  extra: h(Tag, null, data.dataMode === "live" && data.sources && data.sources.sectors === "live" ? "盘中实时" : "收盘快照"),
                },
                h(SectorCard, { sectors: data.sectors, compact: tight, onPickSector: pickSector }),
              ),
            ),
          );
          sections.push(
            h(
              SectionCard,
              { key: "kline", title: "上证指数 · 60 日日K", hint: "蜡烛 / MA5 / MA10 / MA20（腾讯行情）" },
              h(KlineCard, { kline: data.kline }),
            ),
          );

          var warnings = data.warnings || [];
          body = h(
            "div",
            {
              style: {
                padding: "14px 16px 26px",
                display: "flex",
                flexDirection: "column",
                gap: 12,
                overflowY: "auto",
                minHeight: 0,
                flex: 1,
              },
            },
            overview.error
              ? h(
                  "div",
                  {
                    style: {
                      fontSize: 12,
                      color: COLORS.down,
                      border: "1px solid " + COLORS.border,
                      borderRadius: 8,
                      padding: "7px 10px",
                    },
                  },
                  overview.error + "（显示的是上一次成功的数据）",
                )
              : null,
            sections,
            h(
              "div",
              { style: { fontSize: 11.5, color: COLORS.faint, lineHeight: 1.7, paddingTop: 2 } },
              "数据来源：指数、分时与日 K 来自腾讯公开行情（实时）；盘中涨跌家数、涨跌停、行业板块来自东方财富实时接口（60 秒缓存），成交额来自腾讯实时报价并按交易时间折算全天；盘后改用 market-report 最新收盘快照。",
              h("br"),
              "市场温度为宽度 / 涨跌停 / 量能 / 动量的加权评分；盘中量能已按已走完的交易分钟折算。",
              h("br"),
              "仅供研究参考，不构成投资建议。",
              warnings.length ? h("br") : null,
              warnings.length ? "部分数据降级：" + warnings.join("；") : null,
            ),
          );
        }
      }

      if (view === "moves") {
        body = h(MovesPanel, {
          registerReload: function (fn) {
            movesReloadRef.current = fn;
          },
          onMeta: setMovesMeta,
          onPickStock: setSelectedStock,
        });
      } else if (view === "news") {
        body = h(NewsHub, {
          registerReload: function (fn) {
            newsReloadRef.current = fn;
          },
          onMeta: setNewsMeta,
          initialSector: sectorPick ? sectorPick.sector : "",
          initialSectorCode: sectorPick ? sectorPick.code || "" : "",
          initialSectorSeq: sectorPick && isNum(sectorPick.seq) ? sectorPick.seq : 0,
          onClearInitialSector: function () {
            setSectorPick(null);
          },
        });
      } else if (view === "research") {
        body = h(ResearchPanel, {
          registerReload: function (fn) {
            researchReloadRef.current = fn;
          },
          onMeta: setResearchMeta,
        });
      } else if (view === "strategy") {
        body = h(StrategyView, {
          registerReload: function (fn) {
            strategyReloadRef.current = fn;
          },
          onMeta: setStrategyMeta,
        });
      }

      return h(
        "div",
        {
          "data-dsh-wallstreet-panel": "",
          "data-dsh-wallstreet-view": view,
          ref: rootRef,
          style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
        },
        toolbar,
        body,
        selectedStock
          ? h(StockModal, {
              code: selectedStock,
              onClose: function () {
                setSelectedStock(null);
              },
            })
          : null,
      );
    }

    /* ------------------------------ 注册 ------------------------------ */

    var inject = ["slots", "layout"];

    function apply(ctx) {
      var disposers = [];

      var selectConversation = function () {
        try {
          ctx.layout.selectPanel(null);
        } catch (error) {
          console.warn("[dsh-wallstreet] 返回对话失败:", error);
        }
      };

      try {
        var slots = ctx.slots;
        disposers.push(
          slots.inject("sidebar.panellist", function () {
            return slots.register(
              {
                name: "sidebar.panellist",
                id: PANEL_ID,
                order: PANEL_ORDER,
                label: function () {
                  return "华尔街之狼";
                },
              },
              WallstreetPanelIcon,
            );
          }),
        );
        disposers.push(
          slots.inject("main", function () {
            return slots.register(
              {
                name: "main",
                key: PANEL_ID,
                inject: function () {
                  return { selectConversation: selectConversation };
                },
              },
              Dashboard,
            );
          }),
        );
      } catch (error) {
        console.warn("[dsh-wallstreet] panel registration failed:", error);
      }

      ctx.effect(function () {
        return function () {
          for (var index = 0; index < disposers.length; index += 1) {
            try {
              disposers[index]();
            } catch {}
          }
          disposers.length = 0;
        };
      }, "dsh-wallstreet: ui mounts");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
