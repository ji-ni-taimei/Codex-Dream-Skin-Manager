# 内置皮肤

`catalog.json` 包含 32 项，已移除「浪漫玫瑰」「云端遐想」「海面玻璃」「玻璃工作台」及其素材。管理器还会读取本目录下带 `theme.json` 的 `preset-*` 主题包，合并到「内置」列表；保留的 catalog 条目顺序不变。

## 维护者个人动态皮肤

以下九款来自维护者明确要求收录的本机「我的皮肤」。原始 MP4 直接复制到各包的 `background.mp4`，没有压缩或转码；沿用保存的取景、缩放、消息气泡不透明度、强调色和自动浅暗设置，面板不透明度统一为 30%，原名保留为搜索标签。其中「次元少女」「倾天泻雨」保留原名。已有内置的桥本有菜和四款二狗子皮肤不重复添加，个人主题副本仍保留。

| 主题 ID | 原名 | 四字名称 | 字节数 |
| --- | --- | --- | ---: |
| `preset-neon-azure-dream` | 81 | 霓蓝绯梦 | 22755332 |
| `preset-sunlit-breeze-walk` | 休闲 | 晴风漫步 | 35250785 |
| `preset-starlit-guardian` | 迪迦 | 星海之光 | 15609162 |
| `preset-ink-shadow-snow-eyes` | 次元少女 | 次元少女 | 8866884 |
| `preset-cloud-whisper-window` | 伊蕾娜 | 晴窗云语 | 77655162 |
| `preset-crimson-feather-dusk` | 绘梨衣 | 绯羽暮歌 | 87339934 |
| `preset-moonlit-tidal-blade` | 倾天泻雨 | 倾天泻雨 | 74246865 |
| `preset-starlit-embers` | 苍穹 | 星烬长空 | 9660768 |
| `preset-prismatic-star-eyes` | 星瞳 | 琉光星眸 | 19665742 |

SHA-256（按上表顺序）：

```text
B557C2984E3760C6A2478D0C103F5603F0DC9149CDB8A9474040428BF7423710
401D07025BAB28BA6BC98772F46B519172052D3BCFCF6165E32B9D0D05BC9E7D
48617619924BCE27DB2856249EBCA72F1DC9839842910FDF9E67B3FF7334AC85
012D9FCA46A05334F5731A0B81CB14DCA5545780136AE508F7D68E687AF395AC
262650D7723A074265C264F82DB1D0503442FF2D38D750130099818A12080F78
F71F6C754500D1E3E4B575E45162BF0DAD3749551D9CDB3D306935A8D386147C
9B094B8CCC952A50035B8EA7262394BF0B7C5AD9CC12A51A158610912B1CD1ED
A10D0A791487102AB90B4C7C49DCF438ACDD18B6C3949CD12AD84B836D18729F
90CAF96091C70A117EF832C3C313EACBC366911C59438B6EF6EB585F11C496D4
```

Windows 直接读取这些主题包；macOS 组装从这里复制同一份资源与元数据。所有内置皮肤的面板不透明度默认为 30%：catalog 主题继承共享默认值，目录主题包显式保存 `art.surfaceOpacity: 0.3`。这些素材同样不属于 MIT 软件许可证的授权范围，参见 [第三方素材说明](../../THIRD_PARTY_NOTICES.md)。

## 维护者提供的四款壁纸

本项目从 `rxkjovo/Codex-Dream-Skin-Manager` 的 `b385bab73ef1d29e980982de4cf58473cef051cd` 提交移植这四款主题包，原始字节保持不变。fork 的来源记录为其工作区根目录 `内置壁纸/`，原文件直接复制为主题包中的 `background.*`，没有压缩或转码；该来源目录不属于本项目。Windows 与 macOS 使用相同的媒体文件和元数据。

| 主题 ID | 显示名称 | 原始素材 | 字节数 |
| --- | --- | --- | ---: |
| `preset-tyndall-rays` | 丁达尔光-光影-光线 | `丁达尔光-光影-光线.jpg` | 2427915 |
| `preset-hokuriku-road` | 公路-北陆-好看 | `公路-北陆-好看.jpg` | 2373344 |
| `preset-cold-elegance` | 冷艳 | `冷艳.mp4` | 56112345 |
| `preset-summer-forest` | 夏天森林-大树仰拍 | `夏天森林-大树仰拍.png` | 20737951 |

SHA-256（按上表顺序）：

```text
0133B2A22161709329001CE49D3E740C6D760E0136E9D513BC743BA8353FD008
04DD0AD38C571D4F683729D8DFBDBB125DFBC6CDD10AA3837DDACAD6EE3224F1
35A0A64D6F79CCB971F75CFE1EB1C75CF3C7DA4E0151928F29A0D999A3637A4D
CD606C25F425E844379CD3E97E3ABF88A4824976513C6BF8736A35A9BD0C72B5
```

前三款沿用维护者已保存的皮肤取景和强调色，面板不透明度统一为 30%；夏天森林采用相同的默认参数：外观 `auto`、居中且缩放为 1、对话气泡不透明度 0、面板不透明度 0.3。用户「我的」中的主题仍独立保留，不随内置主题包替换。

这些图片和视频不属于 MIT 软件许可证的授权范围；参见 [第三方素材说明](../../THIRD_PARTY_NOTICES.md)。
