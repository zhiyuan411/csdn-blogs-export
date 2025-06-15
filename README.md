# CSDN 博客导出工具

CSDN 博客导出工具是一个命令行自动化工具，用于将 CSDN 博客文章批量导出为 Markdown 格式，方便备份、迁移或离线阅读。

工具通过Puppeteer实现浏览器自动化，能够处理CSDN的登录认证、文章列表获取、内容抓取及本地保存等完整流程。


## 功能特点

- 批量导出 CSDN 博客文章为 Markdown 文件
- 自动登录CSDN账号和会话持久化（避免重复登录）
- 获取完整文章列表，包括公开、私有和审核中的文章
- 支持按时间过滤需要导出的文章
- 支持单独导出特定ID的文章
- 自动处理文章中的图片和链接
- 支持按主题分类存储文章
- 提供多种运行模式，满足不同场景需求
- 内置自动重试机制，单篇文章错误不会中断整个导出任务
- 支持断点续传，避免重复下载

## 安装指南

### 前置要求

- 已安装 [Node.js](https://nodejs.org/) (推荐 v14 及以上版本)
- 已安装 [npm](https://www.npmjs.com/) 或 [yarn](https://yarnpkg.com/)
- Chromium浏览器（Puppeteer会自动安装）

### 安装步骤

```bash
# 克隆仓库
git clone https://github.com/zhiyuan411/csdn-blogs-export.git

# 进入项目目录
cd csdn-blogs-export

# 安装依赖
npm install

# 复制配置文件模板
cp config.yml.dist config.yml
```

### 配置说明

编辑 `config.yml` 文件进行个性化配置：

```yaml
# CSDN账号信息
csdn:
  user_id: 'your-csdn-id'       # CSDN账号用户名
  user_pwd: 'your-csdn-password' # CSDN账号密码

# 目录配置
directories:
  user_data: './userData'         # 浏览器缓存和配置存储目录
  default_download: './downloads' # 文章默认下载目录
  download_paths:                # 按主题分类的存储路径
    '前端开发': './downloads/frontend'
    '后端技术': './downloads/backend'

# 通用配置
general:
  cookie_file: './cookie.txt'     # Cookie存储文件路径
  process_log: true               # 是否打印详细处理日志
  action_interval_time: 2000      # 操作间隔时间(毫秒)
  viewport_width: 1080            # 浏览器视窗宽度
  viewport_height: 600            # 浏览器视窗高度
  # 其他配置...

# 需要强制导出的文章ID
article_ids:
  markdown_format_ids: [12345678, 98765432]  # Markdown格式文章ID
  old_format_ids: []                        # 旧格式文章ID

# 其他配置...
```

#### CSDN 账号配置

- `user_id`: CSDN 用户名（通常为手机号、邮箱或用户名）
- `user_pwd`: CSDN 密码

#### 目录配置

- `user_data`: 存储浏览器缓存和配置，避免重复登录
- `default_download`: 文章默认下载目录
- `download_paths`: 按主题分类存储文章的配置，键为主题名称，值为存储路径

#### 通用配置

- `cookie_file`: 存储登录 Cookie 的文件路径
- `process_log`: 是否打印详细的处理过程日志
- `action_interval_time`: 操作间隔时间（毫秒），设置过短易被 CSDN 屏蔽

### 安装和配置实例

[阿里云服务器自动定时备份CSDN博客内容](https://blog.csdn.net/zhiyuan411/article/details/143450143)

## 使用方法
### 脚本命令（基于 package.json）

```bash
# 正常模式：导出3天内的文章
npm start

# 调试模式：启动浏览器UI界面（1天内文章）
npm run debug

# 配置模式：手动登录并保存Cookie
npm run setup

# 登录模式：仅执行登录流程
npm run login

# 单篇模式：导出配置中指定的文章
npm run single

# 全量模式：导出所有文章
npm run all
```


### 命令行参数

```bash
node index.js [runMode] [dayOffset]
```

- `runMode`: 运行模式，可选值: `run`, `debug`, `setup`, `login`, `single`
- `dayOffset`: 天数偏移量，导出最近N天更新的文章，默认 `-1`（表示导出所有文章）

### 运行模式说明

#### 正常模式 (run)

```bash
node index.js run
```

- 无头模式运行，适合服务器环境
- 自动登录并导出所有符合条件的文章

#### 调试模式 (debug)

```bash
node index.js debug
```

- 启动浏览器UI界面，便于观察运行过程
- 执行完毕后保持浏览器打开，方便人工验证
- 适合调试和问题排查

#### 设置模式 (setup)

```bash
node index.js setup
```

- 启动浏览器UI界面，用于记录登录信息
- 适合首次使用或登录信息需要更新时
- 手动完成登录后，工具会保存登录状态

#### 登录模式 (login)

```bash
node index.js login
```

- 启动浏览器UI界面，使用配置的账号密码进行登录
- 仅完成登录操作，不执行导出
- 用于测试登录功能或更新Cookie

#### 单篇模式 (single)

```bash
node index.js single
```

- 仅导出配置文件中指定的文章
- 适合需要单独导出特定文章的场景

## 项目结构

```
csdn-blogs-export/
├── index.js                 # 入口文件，核心逻辑实现
├── config.yml.dist          # 配置文件示例
├── config.yml               # 配置文件（需手动创建）
├── userData/                # 浏览器缓存和配置目录
├── downloads/               # 文章默认下载目录
├── package.json             # 依赖配置
├── package-lock.json        # 依赖版本锁定文件
└── README.md                # 项目说明文档
```

## 常见问题
### 如何获取CSDN的cookie？

1. 一般无需手动获取，脚本会自动模拟登录后保持cookie持久状态到本地
2. 对于视窗系统（也包括MacOS等）可以使用 `setup`、`login` 等方式来在浏览器UI界面手动登录
3. 对于服务器版参考 [解决登录需要滑动滑块验证的问题](https://xiaobai.blog.csdn.net/article/details/148631404) 手动获取并保存cookie


### 登录失败怎么办？

1. 确保配置文件中的账号密码正确
2. 尝试使用 `setup` 模式手动登录（会自动保存登录状态）
3. 检查网络环境，确保可以正常访问 CSDN
4. 如果频繁登录失败，可能是IP或账号被临时限制，建议稍后再试

### 文章内容为空怎么办？

1. 可能是被CSDN防抓取机制所屏蔽，在配置中启用自定义UA再次尝试
2. 尝试使用 `debug` 模式查看具体错误
3. 确认 CSDN 接口是否有变化，可能需要更新代码
4. 可能是IP或账号被临时限制，建议稍后再试

### 导出的Markdown文件用于自己网站，图片无法展示怎么办？

1. CORS策略导致该问题，解决方法是 [代理图片请求](https://blog.csdn.net/zhiyuan411/article/details/143518966)
2. 检查配置文件中的 `replacements` 配置是否正确
3. 确认图片链接是否有效

## 贡献指南

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add some amazing feature'`)
4. 推送分支 (`git push origin feature/amazing-feature`)
5. 提交 Pull Request

## 许可证

[MIT](LICENSE) © 2025 zhiyuan411

## 联系方式
如果你有任何问题或者建议，可以通过以下方式联系我：
- GitHub: [zhiyuan411](https://github.com/zhiyuan411)
- Email: <zhiyuan411@gmail.com>