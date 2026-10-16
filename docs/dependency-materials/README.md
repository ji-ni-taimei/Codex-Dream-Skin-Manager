# 共享构建依赖许可补充材料

2026-10-16 / FR-2026101517。原文保持取得的字节；来源、SHA-256、版本关联及限制见 [provenance.json](provenance.json)。这是本地依赖准备材料，尚未关联完整分发候选或最终 THIRD_PARTY 落点。

| 原文 | 来源依据 | 覆盖限制 |
| --- | --- | --- |
| [esbuild 0.24.2](esbuild-0.24.2-LICENSE.md) | 官方 v0.24.2 tag；与实际 esbuild wrapper LICENSE 字节相同；`@esbuild/win32-x64` 的实际 manifest 指向相同仓库/版本并声明 MIT | 平台包本身未附根目录 LICENSE；未审计二进制内完整第三方闭包 |
| [Rollup 4.64.7](rollup-4.64.7-LICENSE.md) | 官方 v4.64.7 tag；与实际 Rollup wrapper LICENSE 字节相同，含上游列出的 bundled notices；两个已安装 win32-x64 包声明相同仓库/版本和 MIT | 平台包本身未附根目录 LICENSE；不能据 wrapper 正文断言原生二进制全部许可已覆盖 |
| [参考程序集上游 LICENSE](dotnet-reference-assemblies-LICENSE.txt) | 两个实际 1.0.3 nuspec 的 licenseUrl 均指向 microsoft/dotnet/LICENSE；从该文件最后修改 commit `7cdf34dec038c4da4d14735a34ab259704ec4a1e` 固定取得（上游日期 2019-10-04） | 属于声明 URL 的原文快照，包内未附此文件；不冒充 nupkg 内原文或最终分发核准 |

原始 npm/NuGet 归档、安装树、nuspec、SDK 及实际已附 LICENSE/NOTICE 材料仍保留在本地忽略的 `artifacts/shared-validation/` 和本轮 `artifacts/shared-validation-02/`。未安装的跨平台可选包、实际打包字节和运行时/继承资产许可仍需继续核对。
