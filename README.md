# 珊瑚直播间 · 排品脚本与商品挂链审核系统

管理直播间、场次、商品、讲解脚本（版本化）、优惠规则、挂链、样品与审核记录。
Python 标准库实现，**零第三方依赖**：SQLite 持久化脚本与版本，本地目录保存样品照片，
商品 / 主播 / 价格 / 发布回执使用进程内模拟适配器。

## 单条本地启动

```bash
python run.py --reset
```

- 自动创建演示样例：已开播场次（发布快照、挂链上架回调、**临时撤品**、**发布回执**）
  和编排中场次（缺货、链接失效、改价、样品不符、违规词五种异常）。
- 然后启动 Web：打开 <http://127.0.0.1:8000>

参数：`--reset` 重建样例（清空 SQLite 与样品照片）、`--port 8080`、`--host 0.0.0.0`。
仅重建样例不启动服务：`python -m live_room.seed --reset`。

## 业务规则

| 主题 | 规则 |
| --- | --- |
| 资料审核 | 商品必须资料审核通过才能加入排品；资料不全不可通过；商品 8 演示驳回 |
| 排品 | 场次维护商品顺序、讲解时长、库存提示阈值、优惠版本；同场商品不可重复 |
| 脚本版本 | 每次修改生成新版本；审核人**不能审核自己编写的脚本**；含违规词不可通过 |
| 发布快照 | `planning → published → live`；发布时冻结整场快照（顺序/脚本过审版本/价格/挂链）；已开始的场次继续使用快照，之后的草稿无法覆盖 |
| 挂链 | 每个排品项一条挂链；同一场次 URL 唯一；**发布前校验整场挂链**（缺失、重复、价格、失效、缺货、脚本审核、异常项）；库存低于阈值只预警不阻断 |
| 六类异常 | 缺货（自动下架）、价格变更（一键同步实时价）、链接失效、样品不符、违规词、临时撤品，分别标记处理 |
| 撤品 | 直播中撤品触发幂等下架，排品卡置灰保留，**已成交订单不受影响** |
| 回调 | `event_id` 幂等去重，`seq` 判定乱序（过期事件记 `stale` 丢弃）；重复回调不重复上下架、不改变已成交订单 |
| 样品 | 照片写入本地目录 `data/samples/`；登记"不符"会给关联排品项打异常 |
| 回执 | 资料审核结果与场次发布均生成进程内模拟回执（编号 `RCP-...`），强制发布会把忽略的问题写入回执与流水 |

## 界面

石墨黑 / 奶油白 / 珊瑚色：

- **场次编排**：排品以横向时间轴呈现；商品卡固定显示图片、库存与挂链状态；
  发布前挂链检查面板；**发布按钮固定在右上角**（开播后变为"快照冻结"）。
- **脚本编辑抽屉**：左侧版本化编辑器，右侧同步展示审核提示
  （违规词实时扫描、审核人=作者拦截、挂链状态、快照提示）。
- **商品审核**：资料提交/通过/驳回，并可直接改价、改库存、切换链接有效性来制造异常。
- **样品登记**：生成演示照片写入本地目录并查看核对结果。
- **回执与流水**：发布/审核回执与全部操作审计记录。

## 目录结构

```
live_room/
  domain.py      状态枚举、违规词扫描、业务异常
  db.py          SQLite 连接、建表（脚本版本/快照/挂链/回调台账/审核流水…）
  adapters.py    进程内模拟：商品目录(价格/库存/链接健康)、发布回执
  services.py    核心领域服务（审核、排品、快照、挂链校验、样品、回调幂等）
  seed.py        演示数据 + SVG 商品图/样品照片生成
  api.py         http.server 路由（JSON API + 静态资源）
  server.py      服务启动
  web/           index.html / app.css / app.js（原生 JS）
data/
  live_room.db   SQLite（脚本与版本等持久化）
  img/           演示商品 SVG（seed 生成）
  samples/       样品照片（本地目录）
tests/test_live_room.py
run.py           单条启动命令
```

## 测试

```bash
python -m unittest discover -s tests -v
```

覆盖：版本快照冻结、挂链整场唯一、价格校验与同步、回调重复/乱序、已成交订单保护、
审核权限（自审拦截、违规词拦截）、资料门槛、六类异常、撤品、样品照片、发布回执。

## 常用 API

```
GET  /api/sessions                         场次列表
GET  /api/sessions/{id}/timeline           时间轴（planning 草稿 / live 发布快照+实时运行态）
GET  /api/sessions/{id}/check              发布前整场挂链校验
POST /api/sessions/{id}/refresh            扫描缺货/改价/失效/样品/违规词
POST /api/sessions/{id}/publish            发布（冻结快照+回执，body {"force": true} 可强发）
POST /api/sessions/{id}/items              加排品（未过审商品 422）
POST /api/items/{id}/script/edit|submit    脚本生成新版本 / 送审
POST /api/items/{id}/script/review         审核（作者=审核人 403，违规词 422）
POST /api/items/{id}/link                  挂链（重复 URL 409）
POST /api/items/{id}/withdraw              临时撤品（幂等下架）
POST /api/links/{id}/callback              平台回调（event_id 幂等、seq 判乱序）
POST /api/links/{id}/order                 演示成交
POST /api/products/{id}/material/submit|approve|reject
POST /api/products/{id}/sample             样品照片（base64，落本地目录）
GET  /api/receipts  /api/audit  /api/samples
```
