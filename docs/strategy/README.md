# Vectra - 个人投资研究策略系统

> 为程序员量身定制的 A 股投资决策支持系统

## 🎯 项目目标

利用编程优势，构建系统化、数据驱动的投资策略框架，实现：
- 自动化数据采集与分析
- 策略回测与优化
- 实时持仓监控
- 风险管理与提醒

## 📊 投资策略

详见 [STRATEGY.md](./STRATEGY.md)

### 核心配置
- **核心持仓 (50%)**: 宽基ETF定投（沪深300、中证500、创业板、科创50）
- **卫星策略 (30%)**: 行业轮动 + 个股精选
- **增强策略 (10%)**: 网格交易 + 可转债
- **应急储备 (10%)**: 货币基金

### 风险收益特征
- 风险偏好：激进型
- 预期年化收益：5-15%（中性场景）
- 最大可接受回撤：30-40%

## 🛠️ 快速开始

### 环境配置
```bash
# 创建虚拟环境
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt
```

### 数据源配置
本项目支持 tushare 和 akshare 两个数据源：

**Tushare（推荐）**
1. 注册获取 token: https://tushare.pro/register
2. 配置环境变量：
   ```bash
   export TUSHARE_TOKEN="your_token_here"
   ```

**Akshare（免费）**
无需注册，直接使用，但数据可能不如 tushare 全面。

### 运行示例
```bash
# 获取ETF数据
python utils/data_fetcher.py --symbol 510300 --start 2023-01-01

# 运行个股筛选
python analysis/screening/stock_screener.py

# 启动监控面板
streamlit run dashboard/app.py
```

## 📁 项目结构

```
vectra/
├── PROJECT.md          # 项目上下文与决策记录
├── STRATEGY.md         # 投资策略详细方案
├── README.md           # 本文件
├── requirements.txt    # Python依赖
├── data/              # 数据存储
│   ├── raw/           # 原始数据
│   └── processed/     # 处理后数据
├── strategies/        # 策略模块
│   ├── core/          # 核心持仓策略
│   ├── satellite/     # 卫星策略
│   └── enhance/       # 增强策略
├── backtest/          # 回测框架
├── analysis/          # 分析工具
│   ├── screening/     # 选股筛选器
│   ├── rotation/      # 行业轮动模型
│   └── grid/          # 网格交易
├── notebooks/         # Jupyter notebooks
├── dashboard/         # Streamlit 监控面板
└── utils/             # 工具函数
```

## 🚀 功能模块

### 已完成
- [x] 投资策略制定
- [x] 项目架构设计

### 开发中
- [ ] 数据采集模块
- [ ] ETF定投计算器
- [ ] 个股筛选器

### 计划中
- [ ] 行业轮动模型
- [ ] 网格交易工具
- [ ] 可转债筛选
- [ ] 回测框架
- [ ] 监控面板

## 📚 学习资源

### 推荐书籍
- 《漫步华尔街》- 投资基础
- 《聪明的投资者》- 价值投资
- 《量化投资以Python为工具》- 技术实现

### 数据源文档
- [Tushare Pro](https://tushare.pro/document/2)
- [Akshare 文档](https://akshare.akfamily.xyz/)

## ⚠️ 免责声明

本项目仅供学习和研究使用，不构成任何投资建议。投资有风险，入市需谨慎。

历史回测表现不代表未来收益，任何投资决策请根据自身情况谨慎判断。

## 📝 更新日志

### 2025-01-20
- 项目初始化
- 完成投资策略制定
- 搭建项目架构

---

**Start investing systematically, not emotionally.**
