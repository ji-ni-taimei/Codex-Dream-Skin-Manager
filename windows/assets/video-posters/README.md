# 内置视频封面

这些 JPEG 从 `windows/presets/` 的视频首帧生成，以原视频 SHA-256 命名，最长边 1200 像素。它们与原视频使用相同的来源及许可，随 Windows 安装包递归收录。

新增或替换内置视频时，在开发机安装 FFmpeg 后运行 `node tools/generate-video-posters.mjs`，将对应封面作为源码素材一同提交。可通过 `DREAM_SKIN_FFMPEG` 指定工具路径。用户运行软件不需要安装 FFmpeg。

封面按视频内容匹配，视频变更后不会误用旧图；应用视频时仍单独校验 Codex 的实际解码能力。
