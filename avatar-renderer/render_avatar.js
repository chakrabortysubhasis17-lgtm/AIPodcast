import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const [,, sessionDir, timelinePath, phonemesPath, audioPath, outputPath] = process.argv;

const readJsonClean = (p) => {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw.trim());
};

(async () => {
    if (!fs.existsSync(timelinePath)) {
        console.error("Missing timeline file: " + timelinePath);
        process.exit(1);
    }

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

    const server = http.createServer((req, res) => {
        if (req.url === '/avatar.vrm') {
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': fs.statSync(modelPath).size,
                'Access-Control-Allow-Origin': '*'
            });
            fs.createReadStream(modelPath).pipe(res);
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const serverPort = server.address().port;

    const overlaysDir = path.join(sessionDir, 'overlays');
    const overlayMap = {};
    if (fs.existsSync(overlaysDir)) {
        const files = fs.readdirSync(overlaysDir);
        for (const file of files) {
            const fPath = path.join(overlaysDir, file);
            if (fs.statSync(fPath).isFile()) {
                const ext = path.extname(file).toLowerCase();
                const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
                overlayMap[file.toLowerCase()] = "data:" + mime + ";base64," + fs.readFileSync(fPath).toString('base64');
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
            '--disable-gpu-vsync',
            '--disable-frame-rate-limit',
            '--ignore-gpu-blocklist',
            '--disable-web-security',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding'
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
            let hudScene, hudCamera;
            let overlayMesh, overlayMat;
            let lowerThirdMesh, ltMat, ltCanvas, ltContext, ltTexture;
            const overlayTextures = {};
            let currentLtText = "";

            let activeViseme = null;
            let activeEmotionKey = null;

            function createStudioBackdrop() {
                const bgCanvas = document.createElement('canvas');
                bgCanvas.width = 1920;
                bgCanvas.height = 1080;
                const ctx = bgCanvas.getContext('2d');

                const grad = ctx.createRadialGradient(960, 480, 100, 960, 540, 1000);
                grad.addColorStop(0, '#1a2333');
                grad.addColorStop(0.5, '#0d131f');
                grad.addColorStop(1, '#05070a');
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, 1920, 1080);

                ctx.strokeStyle = 'rgba(255, 255, 255, 0.025)';
                ctx.lineWidth = 2;
                for (let x = 0; x < 1920; x += 36) {
                    ctx.beginPath();
                    ctx.moveTo(x, 0);
                    ctx.lineTo(x, 1080);
                    ctx.stroke();
                }

                ctx.strokeStyle = 'rgba(56, 189, 248, 0.20)';
                ctx.lineWidth = 6;
                ctx.beginPath(); ctx.moveTo(180, 220); ctx.lineTo(420, 220); ctx.stroke();

                ctx.strokeStyle = 'rgba(244, 63, 94, 0.16)';
                ctx.beginPath(); ctx.moveTo(1500, 220); ctx.lineTo(1740, 220); ctx.stroke();

                const texture = new THREE.CanvasTexture(bgCanvas);
                const geo = new THREE.PlaneGeometry(8, 4.5);
                const mat = new THREE.MeshBasicMaterial({ map: texture });
                const mesh = new THREE.Mesh(geo, mat);
                mesh.position.set(0, 1.35, -2.5);
                mesh.matrixAutoUpdate = false;
                mesh.updateMatrix();
                scene.add(mesh);
            }

            function createPodcastMicrophone() {
                const micGroup = new THREE.Group();

                const foamGeo = new THREE.CylinderGeometry(0.042, 0.042, 0.11, 16);
                const foamMat = new THREE.MeshStandardMaterial({ color: 0x181a1f, roughness: 0.9 });
                const foam = new THREE.Mesh(foamGeo, foamMat);
                foam.position.set(0, 0.05, 0);
                foam.matrixAutoUpdate = false;
                foam.updateMatrix();
                micGroup.add(foam);

                const bodyGeo = new THREE.CylinderGeometry(0.044, 0.044, 0.09, 16);
                const metalMat = new THREE.MeshStandardMaterial({ color: 0x242831, metalness: 0.8, roughness: 0.3 });
                const body = new THREE.Mesh(bodyGeo, metalMat);
                body.position.set(0, -0.04, 0);
                body.matrixAutoUpdate = false;
                body.updateMatrix();
                micGroup.add(body);

                const ringGeo = new THREE.TorusGeometry(0.045, 0.003, 12, 24);
                const ringMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, metalness: 0.9, roughness: 0.2 });
                const ring = new THREE.Mesh(ringGeo, ringMat);
                ring.rotation.x = Math.PI / 2;
                ring.position.set(0, 0.005, 0);
                ring.matrixAutoUpdate = false;
                ring.updateMatrix();
                micGroup.add(ring);

                const armGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.45, 12);
                const arm = new THREE.Mesh(armGeo, metalMat);
                arm.position.set(0.08, -0.22, 0);
                arm.rotation.z = -0.35;
                arm.matrixAutoUpdate = false;
                arm.updateMatrix();
                micGroup.add(arm);

                micGroup.position.set(0.18, 1.10, 0.82);
                micGroup.rotation.set(0.35, -0.4, 0.15);
                micGroup.matrixAutoUpdate = false;
                micGroup.updateMatrix();
                scene.add(micGroup);
            }

            function setupOrthographicHUD() {
                hudScene = new THREE.Scene();
                // 1920x1080 pixel-space: (0,0 is bottom-left; 1920,1080 is top-right)
                hudCamera = new THREE.OrthographicCamera(0, 1920, 1080, 0, -10, 10);

                // 1. LowerThird Graphic (Bottom-Left)
                ltCanvas = document.createElement('canvas');
                ltCanvas.width = 960;
                ltCanvas.height = 160;
                ltContext = ltCanvas.getContext('2d');
                ltTexture = new THREE.CanvasTexture(ltCanvas);

                const geo = new THREE.PlaneGeometry(960, 160);
                ltMat = new THREE.MeshBasicMaterial({ map: ltTexture, transparent: true, opacity: 0 });
                lowerThirdMesh = new THREE.Mesh(geo, ltMat);
                lowerThirdMesh.position.set(70 + (960 / 2), 70 + (160 / 2), 1);
                hudScene.add(lowerThirdMesh);

                // 2. Broadcast Overlay Graphic (Top-Left HUD)
                // Exactly 20% of canvas width = 384px (1920 * 0.20)
                const overlayInitGeo = new THREE.PlaneGeometry(384, 384);
                overlayMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
                overlayMesh = new THREE.Mesh(overlayInitGeo, overlayMat);
                
                // Top-Left positioning: 50px left margin, 50px top margin
                const initialMargin = 50;
                overlayMesh.position.set(initialMargin + (384 / 2), (1080 - initialMargin) - (384 / 2), 2);
                hudScene.add(overlayMesh);
            }

            function renderLowerThirdCanvas(title) {
                ltContext.clearRect(0, 0, 960, 160);

                ltContext.fillStyle = 'rgba(10, 15, 26, 0.94)';
                ltContext.strokeStyle = 'rgba(56, 189, 248, 0.35)';
                ltContext.lineWidth = 3;
                ltContext.beginPath();
                ltContext.roundRect(10, 10, 940, 140, [14]);
                ltContext.fill();
                ltContext.stroke();

                const barGrad = ltContext.createLinearGradient(12, 12, 12, 148);
                barGrad.addColorStop(0, '#e11d48');
                barGrad.addColorStop(1, '#f59e0b');
                ltContext.fillStyle = barGrad;
                ltContext.beginPath();
                ltContext.roundRect(12, 12, 10, 136, [6, 0, 0, 6]);
                ltContext.fill();

                ltContext.fillStyle = '#e11d48';
                ltContext.beginPath();
                ltContext.roundRect(38, 28, 145, 28, [6]);
                ltContext.fill();

                ltContext.fillStyle = '#ffffff';
                ltContext.font = 'bold 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                ltContext.fillText('BEINGABONG', 50, 48);

                ltContext.fillStyle = '#f8fafc';
                ltContext.font = 'bold 32px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                const clean = (title || '').replace(/\[.*?\]/g, '').trim();
                const display = clean.length > 48 ? clean.substring(0, 45) + '...' : clean;
                ltContext.fillText(display, 38, 102);

                ltContext.fillStyle = '#38bdf8';
                ltContext.font = '600 14px monospace';
                ltContext.fillText('SPECIAL BROADCAST FEATURE', 38, 132);

                ltTexture.needsUpdate = true;
            }

            async function init() {
                const vrmLib = window.THREE_VRM || window.THREE;
                const VRM = vrmLib?.VRM;
                const parseFn = VRM?.from || VRM?.fromModel;

                const canvas = document.getElementById('canvas');
                window.__canvas = canvas;

                renderer = new THREE.WebGLRenderer({
                    canvas,
                    antialias: false,
                    stencil: false,
                    depth: true,
                    alpha: false,
                    powerPreference: 'high-performance'
                });
                renderer.setSize(1920, 1080);
                renderer.setPixelRatio(1);
                renderer.outputEncoding = THREE.sRGBEncoding;
                renderer.autoClear = false;

                scene = new THREE.Scene();
                camera = new THREE.PerspectiveCamera(28, 1920 / 1080, 0.1, 20);
                camera.position.set(0, 1.35, 1.15);
                scene.add(camera);

                createStudioBackdrop();
                createPodcastMicrophone();
                setupOrthographicHUD();

                const hemi = new THREE.HemisphereLight(0xffffff, 0x1e293b, 0.85);
                scene.add(hemi);

                const keyLight = new THREE.DirectionalLight(0xfff3e0, 1.35);
                keyLight.position.set(1.2, 2.2, 2.0);
                keyLight.matrixAutoUpdate = false;
                keyLight.updateMatrix();
                scene.add(keyLight);

                const cyanRim = new THREE.DirectionalLight(0x38bdf8, 1.1);
                cyanRim.position.set(-2.2, 1.8, -0.8);
                cyanRim.matrixAutoUpdate = false;
                cyanRim.updateMatrix();
                scene.add(cyanRim);

                const pinkRim = new THREE.DirectionalLight(0xf43f5e, 0.9);
                pinkRim.position.set(2.0, 1.6, -0.8);
                pinkRim.matrixAutoUpdate = false;
                pinkRim.updateMatrix();
                scene.add(pinkRim);

                const textureLoader = new THREE.TextureLoader();
                const rawMap = ${JSON.stringify(overlayMap)};
                for (const [key, dataUrl] of Object.entries(rawMap)) {
                    overlayTextures[key] = textureLoader.load(dataUrl);
                }

                const loader = new THREE.GLTFLoader();
                loader.load('http://127.0.0.1:${serverPort}/avatar.vrm', (gltf) => {
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
                    }).catch(err => console.error("VRM initialization error:", err));
                }, undefined, (err) => console.error("GLTF download error:", err));
            }

            const visemeMap = { 'B': 'i', 'C': 'e', 'D': 'a', 'E': 'u', 'F': 'o', 'G': 'i', 'H': 'a' };

            window.updateFrame = function(t, phoneme, expr, camMode, camAge, activeOverlay, overlayPos, activeGesture, gestAge, ltTitle, ltAge) {
                if (!vrm) return;

                const spine = vrm.humanoid.getBoneNode('spine');
                const head = vrm.humanoid.getBoneNode('head');
                const rArm = vrm.humanoid.getBoneNode('rightUpperArm');
                const rElbow = vrm.humanoid.getBoneNode('rightLowerArm');

                if (spine) spine.rotation.x = Math.sin(t * 2.2) * 0.015;
                if (head) {
                    head.rotation.y = Math.sin(t * 1.1) * 0.03;
                    head.rotation.z = Math.sin(t * 0.8) * 0.015;
                }

                const gest = (activeGesture || '').toLowerCase();
                const isGestActive = gest && gestAge <= 2.2;

                if (isGestActive && gest.includes('nod') && head) {
                    head.rotation.x = Math.sin(gestAge * 9.0) * 0.14;
                } else if (isGestActive && (gest.includes('head shake') || gest.includes('shake')) && head) {
                    head.rotation.y = Math.sin(gestAge * 8.0) * 0.18;
                } else if (head) {
                    head.rotation.x = 0;
                }

                if (isGestActive && gest.includes('point') && rArm && rElbow) {
                    const armProgress = Math.min(1.0, gestAge / 0.4);
                    rArm.rotation.set(-0.6 * armProgress, 0.3 * armProgress, -0.6);
                    rElbow.rotation.set(-0.8 * armProgress, 0, 0);
                } else if (rArm && rElbow) {
                    rArm.rotation.set(-0.25, 0.1, -1.18);
                    rElbow.rotation.set(-1.45, 0, 0);
                }

                const blinkCycle = t % 3.6;
                const blinkVal = blinkCycle < 0.2 ? Math.sin((blinkCycle / 0.2) * Math.PI) : 0;
                vrm.blendShapeProxy.setValue('blink', blinkVal);

                const targetVowel = visemeMap[phoneme] || null;
                if (targetVowel !== activeViseme) {
                    if (activeViseme) vrm.blendShapeProxy.setValue(activeViseme, 0);
                    if (targetVowel) vrm.blendShapeProxy.setValue(targetVowel, 0.88);
                    activeViseme = targetVowel;
                }

                const lower = (expr || 'neutral').toLowerCase();
                let newKey = 'neutral';
                if (lower.includes('joy') || lower.includes('smile')) newKey = 'joy';
                else if (lower.includes('excited')) newKey = 'excited';
                else if (lower.includes('serious') || lower.includes('angry')) newKey = 'angry';
                else if (lower.includes('smug')) newKey = 'smug';
                else if (lower.includes('surprised')) newKey = 'surprised';

                if (newKey !== activeEmotionKey) {
                    ['joy', 'angry', 'sorrow', 'fun'].forEach(e => vrm.blendShapeProxy.setValue(e, 0));
                    if (newKey === 'joy') vrm.blendShapeProxy.setValue('joy', 0.85);
                    else if (newKey === 'excited') { vrm.blendShapeProxy.setValue('joy', 0.95); vrm.blendShapeProxy.setValue('fun', 0.65); }
                    else if (newKey === 'angry') vrm.blendShapeProxy.setValue('angry', 0.70);
                    else if (newKey === 'smug') { vrm.blendShapeProxy.setValue('fun', 0.75); vrm.blendShapeProxy.setValue('joy', 0.35); }
                    else if (newKey === 'surprised') vrm.blendShapeProxy.setValue('fun', 0.90);
                    activeEmotionKey = newKey;
                }

                if (activeEmotionKey === 'excited' && head) head.rotation.y += Math.sin(t * 4.0) * 0.05;
                if (activeEmotionKey === 'smug' && head) head.rotation.z = 0.08;

                vrm.update(1 / 30);

                // TOP-LEFT HUD OVERLAY: 20% width (384px) with dynamic aspect-ratio height
                if (activeOverlay && overlayTextures[activeOverlay.toLowerCase()]) {
                    const tex = overlayTextures[activeOverlay.toLowerCase()];
                    if (overlayMat.map !== tex) {
                        overlayMat.map = tex;
                        overlayMat.needsUpdate = true;
                    }

                    const img = tex.image;
                    if (img && img.width > 0 && img.height > 0) {
                        const targetW = 1920 * 0.20; // 384px (exactly 20% width)
                        const aspect = img.height / img.width;
                        const targetH = targetW * aspect;

                        if (overlayMesh.userData.currentH !== targetH) {
                            overlayMesh.geometry.dispose();
                            overlayMesh.geometry = new THREE.PlaneGeometry(targetW, targetH);
                            const margin = 50;
                            overlayMesh.position.set(margin + (targetW / 2), (1080 - margin) - (targetH / 2), 2);
                            overlayMesh.userData.currentH = targetH;
                        }
                    }
                    overlayMat.opacity = Math.min(1.0, overlayMat.opacity + 0.15);
                } else {
                    overlayMat.opacity = Math.max(0.0, overlayMat.opacity - 0.15);
                }

                const cam = (camMode || '').toLowerCase();
                if (cam.includes('shake')) {
                    if (camAge < 0.65) {
                        const shakeX = (Math.random() - 0.5) * 0.04;
                        const shakeY = (Math.random() - 0.5) * 0.04;
                        camera.position.set(shakeX, 1.35 + shakeY, 0.95);
                    } else {
                        camera.position.set(0, 1.35, 1.15);
                    }
                } else if (cam.includes('slow zoom')) {
                    const zoomProgress = Math.min(1.0, camAge / 5.0);
                    const zoomZ = THREE.MathUtils.lerp(1.30, 0.85, zoomProgress);
                    camera.position.set(0, 1.36, zoomZ);
                } else if (cam.includes('close-up')) {
                    camera.position.set(0, 1.38, 0.75);
                } else if (cam.includes('wide')) {
                    camera.position.set(0, 1.32, 1.45);
                } else {
                    camera.position.set(0, 1.35, 1.15);
                }

                if (ltTitle && ltAge <= 3.0) {
                    if (ltTitle !== currentLtText) {
                        currentLtText = ltTitle;
                        renderLowerThirdCanvas(ltTitle);
                    }

                    let opacity = 1.0;
                    let slideOffset = 0;
                    if (ltAge < 0.4) {
                        const progress = ltAge / 0.4;
                        opacity = progress;
                        slideOffset = (1.0 - progress) * -35;
                    } else if (ltAge > 2.5) {
                        opacity = Math.max(0.0, (3.0 - ltAge) / 0.5);
                    }
                    ltMat.opacity = opacity;
                    lowerThirdMesh.position.y = 70 + (160 / 2) + slideOffset;
                } else {
                    ltMat.opacity = 0;
                }

                renderer.clear();
                renderer.render(scene, camera);
                renderer.render(hudScene, hudCamera);

                return window.__canvas.toDataURL('image/jpeg', 0.75);
            };

            window.renderFrameBatch = function(configs) {
                const results = [];
                for (let i = 0; i < configs.length; i++) {
                    const c = configs[i];
                    results.push(window.updateFrame(
                        c.t, c.phoneme, c.expr, c.cam, c.camAge,
                        c.overlay, c.overlayPos, c.gesture, c.gestAge,
                        c.ltTitle, c.ltAge
                    ));
                }
                return results;
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
        '-thread_queue_size', '1024',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-r', '30',
        '-i', '-',
        '-i', audioPath,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-threads', '0',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        outputPath
    ]);

    // Drain stderr & stdout continuously to prevent OS 64KB pipe buffer deadlock on large renders
    let ffmpegErr = '';
    ffmpeg.stderr.on('data', chunk => {
        ffmpegErr += chunk.toString();
        if (ffmpegErr.length > 4000) ffmpegErr = ffmpegErr.slice(-2000);
    });
    ffmpeg.stdout.resume();

    const totalSeconds = phonemes.metadata?.duration || 10.0;
    const totalFrames = Math.max(30, Math.floor(totalSeconds * 30));

    const BATCH_SIZE = 30;

    for (let f = 0; f < totalFrames; f += BATCH_SIZE) {
        const batchCount = Math.min(BATCH_SIZE, totalFrames - f);
        const configs = [];

        for (let b = 0; b < batchCount; b++) {
            const currentFrame = f + b;
            const currentTime = currentFrame / 30;

            const activeCue = (phonemes.mouthCues || []).find(c => currentTime >= c.start && currentTime <= c.end);
            const phoneme = activeCue ? activeCue.value : 'X';

            const activeExpr = timeline.filter(e => e.type === 'emotion' && e.time <= currentTime).pop()?.value || 'neutral';

            const lastCamEv = timeline.filter(e => e.type === 'cam' && e.time <= currentTime).pop();
            const activeCam = lastCamEv?.value || 'mid';
            const camAge = lastCamEv ? (currentTime - lastCamEv.time) : 0;

            const lastGestEv = timeline.filter(e => e.type === 'gesture' && e.time <= currentTime).pop();
            const activeGesture = lastGestEv?.value || '';
            const gestAge = lastGestEv ? (currentTime - lastGestEv.time) : 999;

            let activeOverlay = null;
            let overlayPos = 'top-left';
            for (const ev of timeline) {
                if (ev.time <= currentTime) {
                    if (ev.type === 'show') {
                        activeOverlay = ev.value;
                        overlayPos = ev.position || 'top-left';
                    } else if (ev.type === 'hide') {
                        activeOverlay = null;
                    }
                }
            }

            const lastLtEv = timeline.filter(e => e.type === 'lowerthird' && e.time <= currentTime).pop();
            const ltTitle = lastLtEv?.value || null;
            const ltAge = lastLtEv ? (currentTime - lastLtEv.time) : 999;

            configs.push({
                t: currentTime,
                phoneme,
                expr: activeExpr,
                cam: activeCam,
                camAge,
                overlay: activeOverlay,
                overlayPos,
                gesture: activeGesture,
                gestAge,
                ltTitle,
                ltAge
            });
        }

        const dataUrls = await page.evaluate((batchConfigs) => {
            return window.renderFrameBatch(batchConfigs);
        }, configs);

        for (const dataUrl of dataUrls) {
            if (dataUrl) {
                const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
                ffmpeg.stdin.write(Buffer.from(base64Data, 'base64'));
            }
        }

        const currentFrameCount = Math.min(f + batchCount, totalFrames);
        if (currentFrameCount % 30 === 0 || currentFrameCount === totalFrames) {
            console.log("PROGRESS:" + currentFrameCount + ":" + totalFrames);
        }
    }

        ffmpeg.stdin.end();
    console.log("LOG:[FFmpeg] Finalizing H.264 stream and muxing master audio...");
    await new Promise((resolve, reject) => {
        ffmpeg.on('close', code => {
            if (code !== 0) reject(new Error(`FFmpeg exited with code ${code}: ${ffmpegErr}`));
            else resolve();
        });
    });
    await browser.close();
    server.close();
    console.log("Success! Video saved to: " + outputPath);
})();

