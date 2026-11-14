# 使用与核验手册

## 1. 启动交互渲染（图形入口）

```bash
node cli/textile.js serve
# 浏览器打开 http://localhost:8080/
```

界面即纺织材质预览窗口，分为左侧 3D 布样与右侧控制面板。

### 交互

| 操作 | 效果 |
| --- | --- |
| 左键拖动 | 轨道旋转（改变观察角度） |
| 右键 / Shift+拖动 | 平移目标点 |
| 滚轮 | 改变观察距离 |
| 距离 / 偏航 / 俯仰滑杆 | 精确设定相机参数 |
| 织物重复尺度滑杆 | 调节纹距（纹理重复频率 0.25×–6×） |
| 弯曲幅度 / 细分密度 | 实时变形网格，法线与方向场同步更新 |

### 采样模式（结果区上方分段按钮）

- **显式多级**：着色器按足迹在显式 mip 链两级间三线性插值，HUD 层级即真实层级。
- **硬件 Mip**：交由 WebGL 内部导数计算 LOD。
- **各向异性**：支持硬件扩展时使用真实各向异性；不支持时自动改为长轴多点模拟并标注降级。
- **点采样（诊断）**：关闭过滤，斜视角与远处可见真实混叠，用于对比证明过滤有效。

HUD 实时显示：实际 LOD、采样模式、纹素足迹（像素）、各向异性比、观察距离、帧间抖动。
右侧“过滤误差”面板列出每一级相对基准级的颜色/法线/方向 RMSE，均由真实纹理数据运算得到。

## 2. 三种检查纹样的近远变化与接缝

在“布样与纹理”下拉框切换：

1. **棋盘格 checker**：大块双色，最容易观察远距离 LOD 切换是否平滑、瓦片边界有无错位。
   缓慢滚动滚轮从近到远，HUD 的 LOD 应从 0 单调上升到最高级，画面不出现边界亮线。
2. **细条纹 pinstripe**：高频细节，斜视角下最容易混叠。对比“点采样”与“各向异性”模式：
   点采样远处闪烁，过滤模式保持稳定条纹而不是整体变淡。
3. **已知方向场 directionfield**：平滑涡旋标量场着色，用于检查各向异性高光在曲面上的
   连续走向；在弯曲幅度最大时旋转视角，高光应随纱线方向流动而不在镜像缝处突然反向。

接缝专项：把织物重复尺度调到最大并正对观察，瓦片相接处不应出现颜色/高光断裂；
离线 `verify` 用“环绕有限差分”量化边界跳变，要求不超过内部相邻纹素差分分布的 1.5 倍。

## 3. 相机轨迹与连续帧抖动

1. 点击“开始录制相机轨迹”，红点闪烁表示录制中。
2. 平稳旋转或推拉相机数秒，点击“停止并保存轨迹 (JSON)”，得到逐帧的相机参数、LOD、足迹与抖动。
3. 离线分析（命令行仅做辅助分析，不渲染界面）：

```bash
node cli/textile.js trajectory --file camera-trajectory-<时间戳>.json
# 输出 output/trajectory-*.json：最大逐帧 LOD 阶跃、平均/最大帧间像素抖动
```

界面 HUD 的“帧间抖动”是对默认帧缓冲小块逐帧 `readPixels` 的平均绝对差，属于真实测量；
静止相机下该值应接近 0，LOD 阶跃应平滑无突变。

## 4. 可核验的离线产物

```bash
npm run build     # = 对三种纹样分别执行 build
node cli/textile.js build --pattern checker --size 256
```

每个 `output/<pattern>/` 目录包含：

- `*-L0..L8-*.png`：三张纹理图各自的全部 mip 级别图像；
- `reference-4x-*.png` 与颜色图的 `reference-4x-albedo.ppm`：4× 最近邻高采样参考图，
  无任何平滑，可与渲染结果逐纹素对照（PPM 便于字节级数值比对）；
- `build-record.json`：纹理构建记录，含种子、生成耗时、各级过滤方式、采样语义说明、
  每级相对基准的 RMSE 与参考图系数。

## 5. 自动化核验

```bash
node cli/textile.js verify --all          # 三纹样全部检查
node test/headless-logic.test.js          # 着色器数学的无 GPU 镜像测试
```

`verify` 检查项：接缝环绕差分有界性、法线/方向向量单位长度、LOD 随距离单调、
过滤相对点采样的残差削减率、弯曲网格切线帧正交性。报告写入 `output/verify-*.json`，
任一不满足则进程以非零码退出。

### 真实 WebGL2 端到端测试（可选，需无头浏览器）

`test/e2e-webgl.test.mjs` 用 Playwright 驱动无头 Chromium（SwiftShader 软件 WebGL2），
对实际渲染做 12 项断言：上下文启动、HUD 遥测、LOD 随距离单调、点采样与过滤差异、
误差面板真实 RMSE、弯曲后仍正常渲染、纹距控制、三纹样切换、截图、构建记录结构。

最小化容器（无 root、无系统库）下的准备配方：

```bash
mkdir -p .e2e && cd .e2e && npm init -y && npm i playwright@1.49.1
npx playwright install chromium
# 若缺 Chromium 系统共享库（libnss3 等），从 Debian 镜像下载对应 deb，
# dpkg-deb -x 解压到本地目录，再设置：
export LD_LIBRARY_PATH=<解压目录>/usr/lib/aarch64-linux-gnu:$LD_LIBRARY_PATH
cd ..
node cli/textile.js serve --port 8155 &
PLAYWRIGHT_PATH="$(pwd)/.e2e/node_modules/playwright/index.js" \
E2E_OUT=./output/e2e node test/e2e-webgl.test.mjs
```

已在该环境实测：SwiftShader 报告 WebGL2 可用、各向异性上限 16×；
12/12 断言通过，相机轨迹录制/导出/CLI 分析闭环正常。
禁用各向异性扩展时界面显示“降级 1 项”并说明改用着色器椭圆足迹模拟；
完全禁用 WebGL2 时显示红色“WebGL2 不可用”横幅与处置建议。

## 6. 异常提示约定

- WebGL2 不可用：界面红色横幅 + 顶栏红色徽章，提示更换浏览器。
- 能力缺失：黄色降级徽章 + HUD 逐条说明替代方案。
- 点采样诊断模式：黄色提示这是诊断用途、会出现真实混叠。
- 命令行错误：打印 `[error] ...` 并以退出码 1 结束，不产出伪造的通过结果。
