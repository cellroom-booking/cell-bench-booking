# 细胞房超净台实时预约

这是一个可部署到 GitHub Pages 的细胞房超净台预约网页。前端免费托管在 GitHub Pages，预约数据免费放在 Supabase Free 项目里；配置完成后，多个人打开同一个网址可以看到实时更新的预约状态。

## 文件

- `index.html`: 页面结构
- `styles.css`: 页面样式
- `app.js`: 预约逻辑、冲突检查、Supabase 实时订阅
- `config.js`: Supabase 项目配置
- `supabase-schema.sql`: Supabase 建表和权限 SQL

## 当前功能

- 6 个细胞台：西区细胞房1 里面/外面、西区细胞房2 里面/外面、东区细胞房 靠窗/靠墙
- 支持新增预约、删除预约、按日期查看、复制当天预约表
- 手机端优先：支持按细胞台筛选，手机上优先显示清晰的预约列表
- 支持多人实时同步
- 数据库级冲突保护：同一细胞台、同一日期，时间段不能重叠
- 未配置 Supabase 时会退回本机模式，方便先预览页面
- 预约数据只从 Supabase 读取，不在 GitHub 源码中内置个人预约名单

## 免费部署步骤

### 1. 创建 Supabase Free 项目

1. 打开 <https://supabase.com/> 并注册。
2. New project，新建一个免费项目。
3. 进入项目后打开 `SQL Editor`。
4. 复制 `supabase-schema.sql` 的全部内容并运行。

### 2. 填写 `config.js`

在 Supabase 项目里打开 `Project Settings` -> `API`，复制：

- `Project URL`
- `anon public` key

然后把 `config.js` 改成：

```js
window.CELL_BOOKING_CONFIG = {
  supabaseUrl: "你的 Project URL",
  supabaseAnonKey: "你的 anon public key",
};
```

不要填写 `service_role` key。网页前端只能放 `anon public` key。

### 3. 部署到 GitHub Pages

1. 新建一个 GitHub 仓库，例如 `cell-bench-booking`。
2. 把本文件夹里的所有文件上传到仓库根目录。
3. 进入仓库 `Settings` -> `Pages`。
4. `Build and deployment` 选择 `Deploy from a branch`。
5. 分支选择 `main`，目录选择 `/root`，保存。
6. 等 GitHub Pages 给出访问地址。

## 上线前检查

- 页面左侧状态显示“多人实时”，不是“本机模式”。
- 两台设备同时打开同一个 GitHub Pages 地址。
- A 设备新增一条不冲突预约，B 设备应在几秒内自动看到。
- A 设备尝试新增同一细胞台、同一日期、重叠时间段，应被拒绝。
- B 设备删除一条预约，A 设备应在几秒内自动消失。

如果页面显示“本机模式”，说明 `config.js` 还没有填 Supabase 配置，或者数据库连接失败。

## 权限说明

当前 SQL 为了免登录使用，允许任何打开网页的人查看、新增和删除预约。这个模式部署最简单，适合实验室内部群链接使用。

源码隐私：GitHub 仓库只保存网页代码和 Supabase 公开连接配置，不保存具体预约人姓名或历史预约表。

如果后续需要追踪谁删除了预约，建议升级为 Supabase Auth 登录版，或增加一个删除密码/管理员页面。

## 稳定性说明

- 前端是纯静态网页，GitHub Pages 不需要服务器进程。
- 预约数据保存在 Supabase，网页刷新或换设备后仍读取同一份共享数据。
- Supabase JavaScript SDK 使用固定版本，并随仓库本地发布，减少第三方 CDN 变化导致的故障。
- 页面每分钟会自动重新拉取当前日期数据；实时连接短暂断开时会自动尝试重连。
- GitHub 源码不内置预约名单，公开仓库不会暴露具体预约人姓名。
- 如果页面显示“实时断开”，通常是网络或 Supabase 临时连接问题，刷新页面即可重新读取数据库当前状态。
