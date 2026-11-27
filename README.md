# T3 Code 用量与上下文状态栏

适用于 [T3 Code Extensions](https://github.com/ZiHao256/t3code-extensions) 的扩展插件，在对话界面增加两处轻量状态显示，数据全部来自 T3 Code 自带接口：

- **顶栏右侧**：每个已登录套餐显示一枚紧凑标签（服务商标识 + `5h 剩余%` + `7d 剩余%`，取最紧的 5 小时窗口和周窗口），悬停查看全部窗口和重置倒计时，点击打开用量页。
- **输入框下方**：左侧显示当前对话上下文用量（`已用 / 上限` 与进度细条），右侧显示当前对话所用套餐的剩余额度。

在「设置 → 扩展 → 用量与上下文状态栏」中可以分别开关顶栏显示、输入框状态栏、上下文进度条和当前套餐额度。

## 安装

1. 安装并打开 [T3 Code Extensions](https://github.com/ZiHao256/t3code-extensions)。
2. 进入「设置 → 扩展 → 浏览」，在链接框中粘贴本仓库地址：
   ```text
   https://github.com/skyqingname/t3x-usage-bar
   ```
3. 点击安装即可。

## 更新与发版

- 扩展有新版本时，修改 `plugin.json` 中的 `version`，提交并推送 `vX.Y.Z` 标签及 GitHub Release。
- 用户在 T3 Code Extensions 的「设置 → 扩展」点击「刷新」即可检测到新版并一键更新。
