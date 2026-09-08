import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const [,, sessionDir, timelinePath, phonemesPath, audioPath, outputPath] = process.argv;

(async () => {
    if (!fs.existsSync(timelinePath)) {
        console.error(`Missing timeline file: ${timelinePath}`);
        process.exit(1);
    }

    const readJsonClean = (p) => {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw.trim());
};
const timeline = readJsonClean(timelinePath);
    let phonemes = { metadata: { duration: 5.0 }, mouthCues: [] };

    if (fs.existsSync(phonemesPath) && fs.statSync(phonemesPath).size > 0) {
        try {
            phonemes = readJsonClean(phonemesPath);
        } catch (e) {
            console.warn("Could not parse phonemes.json", e);
        }
    }

    const modelCandidates = [
        path.join(__dirname, 'public', 'avatar.vrm'),
        path.join(__dirname, 'public', 'avatar1.vrm'),
        path.join(__dirname, 'avatar.vrm'),
        path.join(__dirname, 'public', 'assets', 'models', 'avatar.vrm')
    ];
    const modelPath = modelCandidates.find(p => fs.existsSync(p));
    if (!modelPath) {
        console.error("Could not find avatar.vrm");
        process.exit(1);
    }
    const modelBase64 = fs.readFileSync(modelPath).toString('base64');

    // Preload uploaded scene graphics
    const overlaysDir = path.join(sessionDir, 'overlays');
    const overlayMap = {};
    if (fs.existsSync(overlaysDir)) {
        const files = fs.readdirSync(overlaysDir);
        for (const file of files) {
            const fPath = path.join(overlaysDir, file);
            if (fs.statSync(fPath).isFile()) {
                const ext = path.extname(file).toLowerCase();
                const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
                overlayMap[file.toLowerCase()] = `data:${mime};base64,${fs.readFileSync(fPath).toString('base64')}`;
            }
        }
    }

    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--use-gl=angle',
            '--use-angle=d3d11',
            '--enable-gpu-rasterization',
            '--enable-zero-copy',
            '--disable-web-security'
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <script src="https://unpkg.com/three@0.146.0/build/three.min.js"></script>
        <script src="https://unpkg.com/three@0.146.0/examples/js/loaders/GLTFLoader.js"></script>
        <script src="https://unpkg.com/@pixiv/three-vrm@0.6.11/lib/three-vrm.min.js"></script>
        <style>body { margin: 0; overflow: hidden; background: #07090e; }</style>
    </head>
    <body>
        <canvas id="canvas" width="1920" height="1080"></canvas>
        <script>
            let renderer, scene, camera, vrm;
            let overlayMesh, overlayMat;
            const overlayTextures = {};

            function base64ToArrayBuffer(base64) {
                const binary_string = window.atob(base64);
                const len = binary_string.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                    bytes[i] = binary_string.charCodeAt(i);
                }
                return bytes.buffer;
            }

            // Procedural studio backdrop with neon accent wall
            function createStudioBackdrop() {
                const bgCanvas = document.createElement('canvas');
                bgCanvas.width = 1920;
                bgCanvas.height = 1080;
                const ctx = bgCanvas.getContext('2d');

                // Dark acoustic panel gradient
                const grad = ctx.createRadialGradient(960, 480, 100, 960, 540, 1000);
                grad.addColorStop(0, '#1a2333');
                grad.addColorStop(0.5, '#0d131f');
                grad.addColorStop(1, '#05070a');
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, 1920, 1080);

                // Acoustic vertical slat lines
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.025)';
                ctx.lineWidth = 2;
                for (let x = 0; x < 1920; x += 36) {
                    ctx.beginPath();
                    ctx.moveTo(x, 0);
                    ctx.lineTo(x, 1080);
                    ctx.stroke();
                }

                // Studio neon accent bars (cyan & magenta)
                ctx.strokeStyle = 'rgba(56, 189, 248, 0.18)';
                ctx.lineWidth = 6;
                ctx.beginPath();
                ctx.moveTo(180, 200); ctx.lineTo(400, 200);
                ctx.stroke();

                ctx.strokeStyle = 'rgba(244, 63, 94, 0.14)';
                ctx.beginPath();
                ctx.moveTo(1520, 200); ctx.lineTo(1740, 200);
                ctx.stroke();

                const texture = new THREE.CanvasTexture(bgCanvas);
                const geo = new THREE.PlaneGeometry(8, 4.5);
                const mat = new THREE.MeshBasicMaterial({ map: texture });
                const mesh = new THREE.Mesh(geo, mat);
                mesh.position.set(0, 1.35, -2.5);
                scene.add(mesh);
            }

            async function init() {
                const vrmLib = window.THREE_VRM || window.THREE;
                const VRM = vrmLib?.VRM;
                const parseFn = VRM?.from || VRM?.fromModel;

                const canvas = document.getElementById('canvas');
                window.__canvas = canvas;
                renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
                renderer.setSize(1920, 1080);
                renderer.outputEncoding = THREE.sRGBEncoding;

                scene = new THREE.Scene();
                camera = new THREE.PerspectiveCamera(28, 1920 / 1080, 0.1, 20);
                camera.position.set(0, 1.35, 1.15);
                scene.add(camera);

                createStudioBackdrop();

                // Warm keylight + vibrant cyber rimlights
                const hemi = new THREE.HemisphereLight(0xffffff, 0x1e293b, 0.85);
                scene.add(hemi);
                const keyLight = new THREE.DirectionalLight(0xfff3e0, 1.35);
                keyLight.position.set(1.2, 2.2, 2.0);
                scene.add(keyLight);
                const cyanRim = new THREE.DirectionalLight(0x38bdf8, 1.1);
                cyanRim.position.set(-2.2, 1.8, -0.8);
                scene.add(cyanRim);
                const pinkRim = new THREE.DirectionalLight(0xf43f5e, 0.9);
                pinkRim.position.set(2.0, 1.6, -0.8);
                scene.add(pinkRim);

                // Overlay graphic card
                const textureLoader = new THREE.TextureLoader();
                const rawMap = ${JSON.stringify(overlayMap)};
                for (const [key, dataUrl] of Object.entries(rawMap)) {
                    overlayTextures[key] = textureLoader.load(dataUrl);
                }

                const overlayGeo = new THREE.PlaneGeometry(0.5, 0.5);
                overlayMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
                overlayMesh = new THREE.Mesh(overlayGeo, overlayMat);
                overlayMesh.position.set(0.48, 1.40, 0.15);
                scene.add(overlayMesh);

                const loader = new THREE.GLTFLoader();
                const buffer = base64ToArrayBuffer("${modelBase64}");

                loader.parse(buffer, '', (gltf) => {
                    parseFn.call(VRM, gltf).then((loadedVrm) => {
                        vrm = loadedVrm;
                        scene.add(vrm.scene);
                        vrm.scene.rotation.y = Math.PI;

                        const rArm = vrm.humanoid.getBoneNode('rightUpperArm');
                        const rElbow = vrm.humanoid.getBoneNode('rightLowerArm');
                        const lArm = vrm.humanoid.getBoneNode('leftUpperArm');
                        const lElbow = vrm.humanoid.getBoneNode('leftLowerArm');

                        if (rArm) rArm.rotation.set(-0.25, 0.1, -1.18);
                        if (rElbow) rElbow.rotation.set(-1.45, 0, 0);
                        if (lArm) lArm.rotation.set(0.1, 0, 1.25);
                        if (lElbow) lElbow.rotation.set(0.25, 0, 0);

                        window.__ready = true;
                    }).catch(err => console.error(err));
                });
            }

            const visemeMap = { 'B': 'i', 'C': 'e', 'D': 'a', 'E': 'u', 'F': 'o', 'G': 'i', 'H': 'a' };

            window.updateFrame = function(t, phoneme, expr, camMode, activeOverlay) {
                if (!vrm) return;

                // Subtle breathing & idle head sway
                const spine = vrm.humanoid.getBoneNode('spine');
                const head = vrm.humanoid.getBoneNode('head');
                if (spine) spine.rotation.x = Math.sin(t * 2.2) * 0.015;
                if (head) {
                    head.rotation.y = Math.sin(t * 1.1) * 0.03;
                    head.rotation.z = Math.sin(t * 0.8) * 0.015;
                }

                // Natural blink
                const blinkCycle = t % 3.6;
                const blinkVal = blinkCycle < 0.2 ? Math.sin((blinkCycle / 0.2) * Math.PI) : 0;
                vrm.blendShapeProxy.setValue('blink', blinkVal);

                // Mouth shape
                ['a', 'i', 'u', 'e', 'o'].forEach(v => vrm.blendShapeProxy.setValue(v, 0));
                const targetVowel = visemeMap[phoneme];
                if (targetVowel) vrm.blendShapeProxy.setValue(targetVowel, 0.88);

                // Emotion presets
                ['joy', 'angry', 'sorrow', 'fun'].forEach(e => vrm.blendShapeProxy.setValue(e, 0));
                const lower = (expr || '').toLowerCase();
                if (lower === 'joy' || lower === 'smile') vrm.blendShapeProxy.setValue('joy', 0.8);
                else if (lower === 'angry' || lower === 'serious') vrm.blendShapeProxy.setValue('angry', 0.65);
                else if (lower === 'surprised' || lower === 'smug') vrm.blendShapeProxy.setValue('fun', 0.75);

                vrm.update(1 / 30);

                // Overlay card transition
                if (activeOverlay && overlayTextures[activeOverlay.toLowerCase()]) {
                    overlayMat.map = overlayTextures[activeOverlay.toLowerCase()];
                    overlayMat.opacity = Math.min(1.0, overlayMat.opacity + 0.12);
                    overlayMat.needsUpdate = true;
                } else {
                    overlayMat.opacity = Math.max(0.0, overlayMat.opacity - 0.12);
                }

                // Smooth camera framing
                if (camMode === 'close-up') camera.position.set(0, 1.38, 0.75);
                else if (camMode === 'wide') camera.position.set(0, 1.32, 1.45);
                else camera.position.set(0, 1.35, 1.15);

                renderer.render(scene, camera);
                return window.__canvas.toDataURL('image/jpeg', 0.85);
            };

            init();
        </script>
    </body>
    </html>
    `;

    await page.setContent(htmlContent);
    await page.waitForFunction('window.__ready === true', { timeout: 60000 });

    const ffmpeg = spawn('ffmpeg', [
        '-y',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-r', '30',
        '-i', '-',
        '-i', audioPath,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        outputPath
    ]);

    const totalSeconds = phonemes.metadata?.duration || 10.0;
    const totalFrames = Math.max(30, Math.floor(totalSeconds * 30));

    console.log(`\nRendering studio episode: ${totalFrames} frames...`);

    for (let f = 0; f < totalFrames; f++) {
        const currentTime = f / 30;
        const activeCue = (phonemes.mouthCues || []).find(c => currentTime >= c.start && currentTime <= c.end);
        const phoneme = activeCue ? activeCue.value : 'X';

        const activeExpr = timeline.filter(e => e.type === 'emotion' && e.time <= currentTime).pop()?.value || 'neutral';
        const activeCam = timeline.filter(e => e.type === 'cam' && e.time <= currentTime).pop()?.value || 'mid';

        let activeOverlay = null;
        for (const ev of timeline) {
            if (ev.time <= currentTime) {
                if (ev.type === 'show') activeOverlay = ev.value;
                else if (ev.type === 'hide') activeOverlay = null;
            }
        }

        const dataUrl = await page.evaluate((t, p, expr, cam, overlay) => {
            return window.updateFrame(t, p, expr, cam, overlay);
        }, currentTime, phoneme, activeExpr, activeCam, activeOverlay);

        const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
        ffmpeg.stdin.write(Buffer.from(base64Data, 'base64'));

        if (f % 15 === 0 || f === totalFrames - 1) {
            process.stdout.write(`\rStudio Render: Frame ${f + 1}/${totalFrames} (${Math.round(((f + 1) / totalFrames) * 100)}%)`);
        }
    }

    console.log("\nFinalizing MP4...");
    ffmpeg.stdin.end();
    await new Promise(resolve => ffmpeg.on('close', resolve));
    await browser.close();
    console.log(`Studio video complete: ${outputPath}`);
})();

