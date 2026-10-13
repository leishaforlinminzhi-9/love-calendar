# 爱的日历 💗

一个温暖明亮、iPhone 风格的小网站：用日历记录**每天两份与爱有关的表达**，并根据表达的类型，生成一枚色彩缤纷又风格统一的小图标。手机和电脑浏览器都能用。

- **前端**：原生 HTML / CSS / JS，无需构建，托管在 GitHub Pages
- **后端**：零依赖的 Node 服务，负责拼稳定风格的 prompt、调用图像 API（密钥不暴露给浏览器）
- **数据**：保存在你自己浏览器的 IndexedDB 里，可导出 / 导入 JSON 在设备间迁移
- **日期**：可以补记过去的日子，也可以**提前一天**写明天的；再往后的日期会锁定

## 它是怎么让图标风格稳定的

每个类型（甜言蜜语 / 陪伴 / 礼物 / 照顾 / 拥抱 / 惊喜 / 支持 / 美食 / 心意）在 [`frontend/love-types.js`](frontend/love-types.js) 里固定了**主体**和**配色**；[`server/prompt.js`](server/prompt.js) 里的**风格段落**永远不变。所以同一类型总是同一个主体 + 同一组颜色，整套图标放在日历里很和谐。

输入文字时会按关键词自动识别类型，也可以手动点选。你写的那句话只会作为一个"小细节灵感"加进 prompt，不会改变整体风格。

> 没配置图像 API 或生成失败时，记录不会丢，会先用内置的渐变图标顶着，之后点「重试」即可。

## 本地运行

需要 Node 20.12+。

```bash
cp .env.example .env   # 填入 IMAGE_API_KEY
npm start              # http://localhost:3000
```

不填 `IMAGE_API_KEY` 也能跑，只是用内置图标。

### 图像 API 配置

默认走 OpenAI 的 `/v1/images/generations`。任何兼容的服务都行，改 `.env` 即可：

| 变量 | 说明 |
| --- | --- |
| `IMAGE_API_KEY` | 密钥（只放在后端） |
| `IMAGE_API_BASE` | 默认 `https://api.openai.com/v1` |
| `IMAGE_MODEL` | 默认 `gpt-image-2.5-flare`。**不要用 `gpt-image-1`**：OpenAI 已宣布 2026-10-23 下线；`gpt-image-1-mini` 和 `gpt-image-1.5` 在 2026-12-01 下线 |
| `IMAGE_SIZE` | 默认 `1024x1024`；留空则不发送 `size` |
| `IMAGE_PARAMS` | 额外 JSON，合并进请求体，例如 `{"quality":"medium"}`；其他厂商的字段名（如 `image_size`）也在这里设置 |

默认用最低画质（`quality: low`）+ jpeg：图标最终只显示 256px，没必要花更多钱。后端同时兼容 `data[].b64_json`、`data[].url`、`images[].url` 三种返回格式。

## 省钱与花费提醒

按实测，`gpt-image-2.5-flare` 低画质一张图约 **$0.007**（241 个文字 token × $5/M + 196 个图像 token × $30/M），$50 大约够生成 7000 张。

**复用已生成的图，不重复花钱**（三层）：

1. **浏览器端**：同一台设备上，已经有「同类型 + 同文字」的图标，就直接用，连请求都不发。
2. **服务端缓存**（`data/cache/`）：按「类型 + 文字 + prompt 版本」缓存，空格 / 全半角差异会被归一化。缓存**不含模型名**，将来换模型也能继续复用旧图。
3. **并发去重**：两个相同的请求同时到达，只付一次钱。

只有点「换一张新图标（会消耗额度）」才会绕过缓存。改了 `server/prompt.js` 里的画风想让旧图全部作废时，把 `PROMPT_VERSION` 加 1。

**超过提醒线会警告你**：后端把每次真实调用的花费（按返回的 token 用量精确计算）记在 `data/ledger.json`。累计超过 `BUDGET_WARN_USD`（默认 $50）后，页面顶部会出现红色横幅并弹出提示，设置页的「已花费」一栏也能随时看，后端日志里还会有醒目的 `BUDGET WARNING`。

> **这个账本只统计经过本服务的调用**，不是 OpenAI 账号的总用量。真正的硬上限请在 [OpenAI 后台 Billing → Limits](https://platform.openai.com/settings/organization/billing/limits) 里设置月度预算。
>
> 部署到 Render 免费版时，磁盘是临时的：实例休眠重启后，服务端缓存和账本会被清空（浏览器端复用不受影响）。想让它们长期保留，可以挂 Render 的付费 Disk（并设置 `DATA_DIR`），或者把后端跑在自己的电脑上。

## 部署到 GitHub

GitHub Pages 只能托管静态文件，所以分两部分：前端放 Pages，后端放一个能跑 Node 的免费服务（下面以 Render 为例，仓库里已有 [`render.yaml`](render.yaml)）。

### 1. 推送到 GitHub

Pages 免费版需要**公开仓库**。`.env` 已在 `.gitignore` 里，密钥不会被提交。

### 2. 部署后端（Render）

1. Render → New → Blueprint → 选这个仓库
2. 填环境变量：
   - `IMAGE_API_KEY`：你的图像 API 密钥
   - `ALLOWED_ORIGINS`：你的 Pages 地址，如 `https://<用户名>.github.io`
   - `ACCESS_CODE`：（推荐）自己设一个口令，防止别人刷你的额度
3. 部署完成后得到后端地址，如 `https://love-calendar-api.onrender.com`

> Render 免费实例闲置后会休眠，第一次请求可能要等 30–60 秒。前端打开时会先 ping 一下 `/api/health` 提前唤醒。

### 3. 部署前端（GitHub Pages）

1. 仓库 Settings → Pages → Source 选 **GitHub Actions**
2. 仓库 Settings → Secrets and variables → Actions → **Variables** 新增 `API_BASE` = 后端地址（不带结尾 `/`）
3. 推送到 `main`，[`pages.yml`](.github/workflows/pages.yml) 会自动发布，并把 `API_BASE` 写进 `frontend/config.js`

打开 Pages 地址 → 右上角 ⚙︎ 设置，填入访问口令，就能生成图标了。iPhone 上用 Safari「添加到主屏幕」会得到全屏的 App 体验。

## 防刷保护

后端公开在互联网上，生成图片是要花钱的，所以内置了：

- `ACCESS_CODE`：设置后，没有口令的请求一律 401
- `ALLOWED_ORIGINS`：只允许你的 Pages 域名跨域调用
- `RATE_PER_MIN`（默认 6）：每个 IP 每分钟的生成次数
- `DAILY_LIMIT`（默认 200）：每天的生成总量

## 目录

```
frontend/   静态前端（直接部署到 Pages）
  love-types.js   类型定义：标签、配色、主体、关键词（前后端共用）
  app.js          日历、弹层、生成流程
  store.js        IndexedDB 封装
server/     Node 后端：prompt 构造 + 图像 API 代理 + 静态托管
  prompt.js       稳定的风格 prompt（PROMPT_VERSION 控制缓存失效）
  cache.js        生成图的磁盘缓存
  spend.js        价格表、花费账本
data/       运行时生成：图片缓存 + 花费账本（已被 .gitignore 忽略）
```

## 已知限制

- 记录只存在当前浏览器里，换设备请用 ⚙︎ →「导出 / 导入数据」。如果想自动同步，下一步可以接 Supabase / Cloudflare KV 之类的存储。
- 清除浏览器站点数据会清掉记录，建议偶尔导出备份。
