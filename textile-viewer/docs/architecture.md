# 纺织图案实时展示器 — 架构说明

## 图形入口（主要使用方式）

**唯一的交互式图形入口是项目根目录的 `index.html`**，需经静态服务器托管后访问
（`app.js` 是 ES module，直接 `file://` 打开会被浏览器跨源策略拒绝）：

```bash
node cli/textile.js serve          # 默认 http://localhost:8080/
node cli/textile.js serve --port 9000
```

打开后即获得“纺织材质预览窗口”：可旋转/平移/缩放弯曲布样、调节纹距（织物重复尺度）、
切换采样模式，并在结果区同时查看织纹与实际运算的过滤误差。所有异常均在界面内以
红色提示条或降级徽章显示，不使用弹窗之外的静默失败。

命令行（`cli/textile.js`）**不承担渲染界面**，只负责离线生成可核验产物与分析数据。

## 模块结构

| 文件 | 职责 |
| --- | --- |
| `index.html` + `app.js` | 材质预览窗口、控件、HUD 遥测、采样证据面板、轨迹录制、参考图导出；读取控件 → 单向转换为内核参数 → 驱动 GPU 渲染边界与 CPU 参照 |
| `src/material-params.js` | **界面参数转换边界**：唯一把 UI 单位（纹距滑杆、基础分辨率、LOD 偏移、过滤模式）转换为内核参数的地方；缺字段或越界直接抛错，不做默认值兜底 |
| `src/sampling-spec.js` | **织纹采样接口的唯一定义**：坐标构造（镜像折叠 `mirrorFold` / 周期取样 `repeatTileCoord`）、导数足迹 `footprintFromDerivatives`、LOD `lodFromFootprint`、各向异性 `anisotropyFromFootprint`，以及同名的 GLSL 片段 `samplingGlsl()` |
| `src/weave-sampler.js` | **CPU 参照采样器**：与 GPU 同一套坐标/导数/过滤决策，严格校验全部参数（无默认值），供界面证据面板、测试与 CLI 使用 |
| `src/sampling-probe.js` | **GPU 执行探针**：单点片元着色器调用与正片着色器相同的采样函数，渲染到浮点目标后读回，作为“实际执行”的证据 |
| `src/textile-render-compat.js` | 旧纺织渲染入口（`textureScale/baseSize/mipBias/filterMode` 平铺字段）的兼容适配，转成与 UI 相同的严格内核参数 |
| `src/procedural-textures.js` | 三种无缝程序纹理（棋盘/细条纹/已知方向场）的颜色图、切线空间法线图、经纬方向图 |
| `src/mipmap.js` | 周期盒式过滤的多级纹理链、向量重归一化、RMSE 过滤误差；`selectLod` 仅为足迹规则的兼容适配 |
| `src/mesh.js` | 弯曲织物网格、解析位置/法线/切线帧；UV 镜像调用 `sampling-spec.js` 的 `mirrorFold` |
| `src/shaders.js` | GLSL ES 3.00 顶点/片元着色器；采样坐标/足迹/过滤决策由 `sampling-spec.js` 注入，不再内联第二份公式 |
| `src/renderer.js` | **GPU 执行边界**：WebGL2 上下文、能力探测与降级、纹理上传、轨道相机、双 pass 遥测、GPU 采样探针。只接受已转换的内核参数，自身不做单位换算 |
| `src/math-util.js` | 周期噪声、三角波、编解码等纯函数 |
| `cli/textile.js` | 辅助命令：`build` / `verify` / `trajectory` / `serve`；`verify` 同时执行 CPU 参照采样与旧入口兼容性检查 |
| `cli/image-io.js` | 零依赖 PNG/PPM 写入 |
| `test/headless-logic.test.js` | 无 GPU 的采样内核/参数转换/严格校验测试 |
| `test/sampling-golden.test.mjs` | 冻结的外部行为基线：逐像素、足迹、LOD 与 GPU 探针/CPU 参照一致性的等价性测试 |
| `test/fixtures/sampling-golden/` | 重构前捕获的帧像素、遥测清单与等价边界 |

## 采样职责分离与单位契约

采样被拆成三层，任一层都不能各自发明尺度换算：

1. **坐标构造**：`mirrorFold`（网格侧镜像折叠）与 `repeatTileCoord`（采样侧 `fract(uv·pitch)`）。
   纹距 `pitch` 就是“每 UV 单位的纹理平铺次数”，界面滑杆值原样成为 `uTextureScale`，
   不再有额外的 `×8` 或 `×baseSize` 隐含系数。
2. **导数估计**：足迹统一定义为“每个设备像素沿屏幕轴覆盖的基础级纹素数”。
   GPU 用 `dFdx/dFdy(vUV)`，CPU 参照由调用方显式传入同一对导数；两侧只做一次
   `×pitch×baseSize` 换算，并且只在 `sampling-spec.js` 里做。
3. **过滤决策**：`LOD = clamp(log2(max(足迹,1)) + 偏移)`、各向异性比 `= max/min` 并受设备上限约束；
   显式链、硬件 mip、各向异性、点采样四种模式共用这一决策，点采样为诊断用途的基线。

**等价边界**（写入 `test/fixtures/sampling-golden/manifest.json`）：同一取样点上，
帧像素平均绝对误差 ≤ 1、单通道最大误差 ≤ 4（8-bit 码值）；足迹相对误差 ≤ 1e-4；
LOD 绝对误差 ≤ 1e-4；GPU 探针与 CPU 参照的通道误差 ≤ 4/255、LOD 差 ≤ 0.05、
足迹相对误差 ≤ 2%。落在瓦片接缝上的点不参与对齐比较：`fract` 在接缝处不连续，
1 ulp 的插值差异会落到包裹的另一侧，“同一取样点”本身无定义。

## 采样语义（各纹理族使用各自正确的语义）

- **颜色图**：以 `SRGB8_ALPHA8` 上传，着色器先 `sRGB → linear` 再参与光照，最后转回 sRGB。
  Alpha 为覆盖率，按标量做盒式平均。
- **法线图**：切线空间单位法线，线性解码；每一级 mip 先对解码向量做盒式平均再**重归一化**，
  绝不是把编码字节当颜色平均。Alpha 为粗糙度（标量平均）。
- **方向图**：平面内单位纱线方向向量（dU, dV），同样线性解码、平均后重归一化；
  Alpha 为各向异性强度。着色器通过**网格切线帧 (T, B, N)** 把方向旋转到世界空间后再算各向异性高光。

## UV 镜像与接缝为何不会导致高光反向

1. 网格 UV 用 `fold(t)=1-|1-2·fract(t)|` 产生周期性镜像折叠；采样前再 `fract`，配合 `REPEAT` 包裹。
2. 纹理生成基于连续相位的三角波纱线轮廓与连续 crossing 权重，高度、导数、法线、方向场在
   格点与瓦片边界均为连续函数（无 `fract` 分支重置）。
3. 方向经变形网格的切线帧旋转：镜像折叠让方向对称地旋转而非翻转，世界空间高光方向保持连续。
4. `test/headless-logic.test.js` 数值验证跨多个镜像折叠不存在 >90° 的方向反转，
   且旋转后的方向保持单位长度并与曲面法线正交。

## 多级纹理与非正视角过滤

- 每个纹理生成 9 级（256→1）周期 mip，边缘用取模索引包裹，瓦片天然无缝。
- LOD 由纹素足迹 `log2(footprint)` 选择；JS 端 `selectLod`（兼容适配）与着色器
  `txLod()` 来自 `sampling-spec.js` 的同一条规则，HUD 显示的“实际层级”即真实采样层级。
- 四种采样模式：显式多级链 / 硬件 Trilinear / 各向异性 / 点采样（诊断）。
  非正视角下足迹被拉长；支持硬件各向异性时用扩展，否则着色器沿**长轴**多点采样模拟，
  界面明确标注为降级。
- 远处纹样不会靠降低整体对比度掩盖混叠：`verify` 把每级过滤残差与同尺度**未过滤点采样基线**
  配对比较，要求过滤显著降低 RMSE（实测 20–72%）。单纯降对比度无法通过该对照。
- 采样执行证据：`src/sampling-probe.js` 让 GPU 在真实上传的纹理上运行同一段采样 GLSL，
  读回后与 `src/weave-sampler.js` 的 CPU 参照逐点比较；HUD 的“GPU/CPU 通道误差”与该比较
  结果一致。合成失败（参数缺失、纹理未上传、探针缺失浮点目标）会在界面显示红色错误并抛出，
  不会以默认值伪装成功。

## 能力探测与明确降级

`renderer.detectCapabilities()` 检查 `EXT_texture_filter_anisotropic`、浮点缓冲与渲染器信息，
缺失项以黄色徽章和 HUD 降级清单逐条列出（例如“不支持各向异性：改用着色器椭圆足迹模拟”）。
WebGL2 完全不可用时界面给出红色错误并说明应使用支持 WebGL2 的浏览器。

## 网格变形同步

`mesh.recomputeFrame()` 在弯曲幅度变化时用解析偏导数重算法线与切线，方向场因依附切线帧而
自动同步；验证脚本检查任意弯曲下法线单位长度及切线/法线正交性（误差 < 1e-5）。
全程是真实曲面着色，不存在静态图片替代。
