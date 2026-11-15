# 纺织图案实时展示器（Textile Pattern Viewer）

实时渲染**平铺与弯曲的织物网格**，加载程序生成的经纬纹理（颜色图、切线空间法线图、
纱线方向图），支持改变观察距离、角度与织物重复尺度，并对非正视角纹理足迹做恰当过滤。

## 图形入口（主要使用方式）

**交互式渲染的唯一图形入口是 [`index.html`](index.html)**，经静态服务器托管后访问
（`app.js` 是 ES module，直接 `file://` 打开会被浏览器拒绝）：

```bash
node cli/textile.js serve          # 打开 http://localhost:8080/
```

打开后即为纺织材质预览窗口：可缩放布样、调节纹距与弯曲，结果区同时呈现织纹与
**实际运算**的过滤误差，异常由界面直接提示。命令行仅做离线辅助，不提供渲染界面。

## 采样职责分离

采样被拆成三层，避免各路径各自发明尺度换算：

- `src/sampling-spec.js`：坐标构造（镜像折叠 / 周期取样）、导数足迹、LOD 与各向异性决策的
  唯一定义，同时导出同名 GLSL 片段供着色器使用；
- `src/weave-sampler.js`：与 GPU 同规则的 CPU 参照采样器，严格校验全部参数（缺字段即抛错）；
- `src/sampling-probe.js`：让 GPU 在真实纹理上执行同一段采样 GLSL 并读回，
  与 CPU 参照在同一取样点逐点比对，作为执行证据显示在预览窗口的 HUD 中；
- `src/material-params.js`：界面材质参数 → 内核参数的唯一转换边界；
- `src/textile-render-compat.js`：旧平铺入口（`textureScale/baseSize/mipBias/filterMode`）
  的兼容适配，转换结果与界面路径一致。

重构前后以冻结的像素/足迹/LOD 基线（`test/sampling-golden.test.mjs`）验证织纹表现与
资源格式不变；等价边界见 [docs/architecture.md](docs/architecture.md)。

## 能力要点

- 三种无缝程序纹样：棋盘格、细条纹、已知方向场；颜色/法线/方向各按正确采样语义处理。
- 方向细节经变形网格的切线空间变换；镜像 UV 与接缝不会造成高光突然反向。
- 可核验的 9 级周期 mip 链，按屏幕覆盖选择层级；远处靠真实过滤而非降低整体对比度。
- 四种采样模式（显式链 / 硬件 Trilinear / 各向异性 / 点采样诊断），HUD 显示实际层级与模式；
  缺少各向异性等能力时明确降级并说明替代方案。
- 网格变形时法线与方向场通过解析导数同步更新，全程真实曲面，无静态图片替代。
- 相机轨迹可录制为 JSON，配合命令行分析连续帧 LOD 阶跃与像素抖动。

## 命令行（仅辅助图形渲染）

```bash
npm run build                 # 生成各级纹理、4x 参考图与 build-record.json
node cli/textile.js verify --all   # 接缝/单位向量/LOD 单调性/过滤残差/切线帧/采样参照核验
node cli/textile.js trajectory --file <轨迹.json>  # 轨迹抖动分析
node cli/textile.js serve          # 本地静态服务器（图形入口的托管方式）
node test/headless-logic.test.js   # 无 GPU 的采样内核/参数转换/严格校验测试
npm run test:golden                # 与重构前冻结基线比对像素/足迹/LOD/探针对齐
```

## 文档（图形入口与核验流程的完整说明）

- [docs/architecture.md](docs/architecture.md)：架构、采样语义、接缝/镜像处理、降级策略。
- [docs/usage-and-verification.md](docs/usage-and-verification.md)：界面操作、三纹样近远与接缝
  检查方法、轨迹抖动核验、离线产物与自动化测试。

零运行时依赖，仅需 Node 18+（命令行）与支持 WebGL2 的浏览器（图形入口）。
