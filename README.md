# CALENDAR

一个极简的日历网站：每天记两条和伴侣之间的小事（TA 对你做的、你对 TA 做的都算），按类型自动生成一枚风格统一的小图标。iPhone 风格，自动适配深色模式，手机和电脑浏览器都能用。

- **前端**：原生 HTML / CSS / JS，无需构建，托管在 GitHub Pages
- **后端**：零依赖，同一份代码既能在本机用 Node 跑，也能部署到 **Cloudflare Workers**（免费、不休眠、不用绑卡）。负责**跨设备同步**、拼稳定风格的 prompt、调用图像 API（密钥不暴露给浏览器）
- **同步**：手机、电脑打开同一个网址、填同一个访问口令，看到的是同一份日历。离线也能记，联网后自动合并
- **日期**：可以补记过去的日子，也可以**提前一天**写明天的；再往后的日期会锁定
- **积攒**：太忙了就点「太忙了，先攒着」，之后在空闲的日子**多写几份来兑现**，欠几份会一直帮你记着

## 太忙了？先攒着，日后兑现

- 某天太忙，没法记两条：点当天的「太忙 · 先攒 N 条」，当天**还空着的位置**会变成"已攒下"（日历格子里显示一个小小的 zzz，每天最多攒 2 条）。
- **待兑现 = 攒下的条数 − 已兑现的条数**，显示在「本月」卡片里。
- 之后在任何一天（含明天），只要还欠着，当天就会多出一个「兑现一条」入口，可以在这天**额外**再记一条（一天最多额外兑现 4 条）。记一条，待兑现就少一条。
- 点一下"已攒下"的位置，可以直接补记，或者「取消积攒」。
- 刚刚攒下的那一天不会出现兑现入口：今天忙到要攒着，当天再去补写说不通。
- 攒下的 💤 不算"已记录"，不会增加"连续记录天数"，也不计入月度统计。
- 这些都只是普通记录，所以和其他数据一样**跨设备同步**，两台设备算出来的"还欠几份"始终一致。

## 跨设备同步是怎么工作的

- 每台设备都有一份**自己的本地副本**（IndexedDB），所以打开就是秒开，断网也能写。
- 改动会标记为"待同步"，联网后推给后端；后端把比你游标更新的内容发回来。启动时、切回标签页时、联网时、每分钟，以及每次修改后都会同步一次。
- 同一条（同一天同一个位置）在两台设备上都改了：**以最后一次修改为准**。
- 删除会同步给所有设备（后端记一个"删除标记"，而不是真的抹掉）。
- 图标只存一份小图（约 20KB），按「类型 + 文字」去重；新设备会按需把图标下载下来。
- 如果后端的数据被清空（比如换了存储），设备发现后会**自动把完整数据重新推回去**，不会丢。
- 日记是私密的：**没有设置 `ACCESS_CODE` 时，后端只回应本机的请求**，远程访问一律 403。
- 打开网站时，如果这台设备还没有口令，**第一个出现的是口令窗口**，输对之前后面的内容都用不了。可以勾选「在此设备上记住」，不勾则只在这次浏览器会话里有效。口令在服务器上被改掉后会再次弹出；设置里的「锁定 · 清除本机口令」也会清除本机口令并重新弹出。
- 口令窗口只是登录同步用的，**不是对本机数据加密**：数据在你自己浏览器里，能打开这台设备的人仍然看得到。

### 后端数据存哪

| 场景 | 存储 | 说明 |
| --- | --- | --- |
| 本机运行 `npm start` | 文件（`data/`） | 默认，不用配置 |
| 线上（Cloudflare Workers / Render 等） | **Upstash Redis**（必须） | 免费、持久、纯 HTTP，不用装任何驱动 |

Workers 没有磁盘，Render 免费版的磁盘休眠重启就清空，所以线上**必须**接 Upstash（后端检测到 Render + 文件存储会在设置页和日志里给出警告）。设置只要两分钟：

1. 到 [console.upstash.com](https://console.upstash.com) 新建一个 Redis 数据库（Region 选离你近的，免费版即可）
2. 在数据库页的 **REST API** 一栏复制 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`
3. 把这两个值作为密钥填给线上后端（见下面的部署步骤）

数据量很小：一条记录几百字节，一年约 700 条加几百个 20KB 的图标，远低于免费额度。

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
2. **服务端缓存**：生成出来的原图和浏览器上传的小图都存在持久存储里，按「类型 + 文字 + prompt 版本」查找，空格 / 全半角差异会被归一化。缓存**不含模型名**，将来换模型也能继续复用旧图。
3. **并发去重**：两个相同的请求同时到达，只付一次钱。

只有点「换一张新图标（会消耗额度）」才会绕过缓存。改了 `server/prompt.js` 里的画风想让旧图全部作废时，把 `PROMPT_VERSION` 加 1。

**超过提醒线会警告你**：后端把每次真实调用的花费（按返回的 token 用量精确计算）累加到持久存储里的**原子计数器**（多处同时运行也不会互相覆盖）。累计超过 `BUDGET_WARN_USD`（默认 $50）后，页面顶部会出现红色横幅并弹出提示，设置页的「已花费」一栏也能随时看，后端日志里还会有醒目的 `BUDGET WARNING`。

> **这个账本只统计经过本服务的调用**，不是 OpenAI 账号的总用量。真正的硬上限请在 [OpenAI 后台 Billing → Limits](https://platform.openai.com/settings/organization/billing/limits) 里设置月度预算。

## 部署到 GitHub

GitHub Pages 只能托管静态文件，所以分两部分：**前端放 Pages，后端放一个能跑 JS 的免费服务**。后端有两种选择：

| | Cloudflare Workers（推荐） | Render |
| --- | --- | --- |
| 费用 | 免费，不用绑卡 | 免费，但创建服务时可能要求绑卡验证 |
| 休眠 | 不休眠 | 闲置 15 分钟后休眠，再次访问要等 30–60 秒 |
| 配置文件 | [`wrangler.toml`](wrangler.toml) | [`render.yaml`](render.yaml) |

### 1. 推送到 GitHub

Pages 免费版需要**公开仓库**。`.env` 已在 `.gitignore` 里，密钥不会被提交。

### 2A. 部署后端：Cloudflare Workers（推荐）

1. 注册一个 [Cloudflare](https://dash.cloudflare.com/sign-up) 免费账号。
2. 在项目目录里登录并部署（会在浏览器里授权一次）：
   ```bash
   npx wrangler@4 login
   npx wrangler@4 deploy
   ```
   第一次部署会让你起一个 `workers.dev` 子域名，完成后得到后端地址，形如 `https://love-calendar-api.<你的子域名>.workers.dev`。
3. 设置 4 个密钥（每条命令会提示你粘贴值，粘贴时屏幕不显示是正常的）：
   ```bash
   npx wrangler@4 secret put IMAGE_API_KEY
   npx wrangler@4 secret put ACCESS_CODE
   npx wrangler@4 secret put UPSTASH_REDIS_REST_URL
   npx wrangler@4 secret put UPSTASH_REDIS_REST_TOKEN
   ```
   `ACCESS_CODE` 是你自己编的口令，**必填**，它既保护你的日记，也防止别人刷你的额度。
4. 验证：`curl https://你的后端地址/api/health`，应该看到 `"store":"upstash"` 和 `"imageConfigured":true`。

`wrangler.toml` 里已经写好了不涉及密钥的配置（模型、`ALLOWED_ORIGINS` 等）。免费版每个请求最多只能对外发 50 次请求，后端的存储读写已经做了批量化（一次同步 700 条记录只需要 3 次）。

### 2B. 部署后端：Render（备选）

1. Render → New → Blueprint → 选这个仓库（找不到 Blueprint 入口也可以手动建一个 Web Service：Build Command 填 `npm install --omit=dev`，Start Command 填 `npm start`）
2. 填环境变量：`IMAGE_API_KEY`、`ALLOWED_ORIGINS`（你的 Pages 地址，如 `https://<用户名>.github.io`）、`ACCESS_CODE`、`UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`
3. 部署完成后得到后端地址，如 `https://love-calendar-api.onrender.com`

### 3. 部署前端（GitHub Pages）

1. 仓库 Settings → Pages → Source 选 **GitHub Actions**
2. 仓库 Settings → Secrets and variables → Actions → **Variables** 新增 `API_BASE` = 后端地址（不带结尾 `/`）
3. 推送到 `main`，[`pages.yml`](.github/workflows/pages.yml) 会自动发布，并把 `API_BASE` 写进 `frontend/config.js`

打开 Pages 地址 → 右上角 ⚙︎ 设置，填入访问口令，就开始同步并能生成图标了。**每台设备都要填一次同样的口令**。iPhone 上用 Safari「添加到主屏幕」会得到全屏的 App 体验。

## 访问保护

后端公开在互联网上，里面是你的私密日记，生成图片还要花钱，所以内置了：

- `ACCESS_CODE`：设置后，没有口令的请求一律 401；**没设置时，后端只回应本机请求**（远程 403）
- `ALLOWED_ORIGINS`：只允许你的 Pages 域名跨域调用
- `RATE_PER_MIN`（默认 6）：每个 IP 每分钟的生成次数
- `DAILY_LIMIT`（默认 200）：每天的生成总量

限流计数放在持久存储里，而不是内存里，所以在 Workers 这种多处同时运行的环境里也准确。

## 目录

```
frontend/   静态前端（直接部署到 Pages）
  love-types.js   类型定义：标签、配色、主体、关键词（前后端共用）
  app.js          日历、弹层、生成流程、积攒与兑现、同步引擎
  store.js        本地 IndexedDB 封装
server/     后端（一份业务代码，两个入口）
  app.js          与运行环境无关的请求处理：同步、图标、生成、限流（标准 Request → Response）
  index.js        Node 入口：本机运行、托管前端静态文件
  worker.js       Cloudflare Workers 入口
  sync.js         同步合并规则（按条目取最后修改、删除标记、纪元、积攒/兑现位置的校验）
  store-file.js   持久存储：本地文件
  store-upstash.js 持久存储：Upstash Redis（批量请求，Workers 也能用）
  prompt.js       稳定的风格 prompt（PROMPT_VERSION 控制缓存失效）
  spend.js        价格表、花费账本
wrangler.toml  Cloudflare Workers 配置
render.yaml    Render 配置
data/       本机运行时生成：同步数据、图标、账本（已被 .gitignore 忽略）
```

## 已知限制

- 这是**单人**日历：所有设备共享同一份数据，由一个访问口令保护，没有多账号。
- 两台设备在**同一个位置**同时改，后改的会覆盖先改的（不会弹冲突提示）。
- 想给自己留一份备份，可以用 ⚙︎ →「导出备份」，它导出的是 JSON 文件。
- 「清空所有记录」会清空**所有设备**上的数据（包括攒着的 💤）。
- Cloudflare 免费版每个请求的 CPU 时间有限制（10ms）；日常使用远低于这个量，但生成图标那一次请求处理较大的图片数据，是离上限最近的一处。
