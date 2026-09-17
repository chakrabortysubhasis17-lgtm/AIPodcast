import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const [,, sessionDir, timelinePath, phonemesPath, audioPath, outputPath, avatarChoiceArg] = process.argv;

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

    const chosenAvatar = (avatarChoiceArg || 'mina').toLowerCase().trim();
    const modelCandidates = [
        path.join(__dirname, 'public', `${chosenAvatar}.vrm`),
        path.join(__dirname, `${chosenAvatar}.vrm`),
        path.join(__dirname, 'public', 'avatar.vrm'),
        path.join(__dirname, 'avatar.vrm')
    ];
    const modelPath = modelCandidates.find(p => fs.existsSync(p));
    if (!modelPath) {
        console.error(`Could not find VRM model for '${chosenAvatar}' in candidate paths.`);
        process.exit(1);
    }
    console.log(`LOG:[Renderer] Using Avatar: ${chosenAvatar} -> ${modelPath}`);

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

    const overlayMap = {};
    const readDirToMap = (dir) => {
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fPath = path.join(dir, file);
                if (fs.statSync(fPath).isFile()) {
                    const ext = path.extname(file).toLowerCase();
                    if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
                        const mime = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
                        const dataUri = "data:" + mime + ";base64," + fs.readFileSync(fPath).toString('base64');
                        const key = file.toLowerCase().trim();
                        overlayMap[key] = dataUri;
                        overlayMap[key.replace(/\.[^/.]+$/, "")] = dataUri;
                    }
                }
            }
        }
    };

    readDirToMap(path.join(sessionDir, 'overlays'));
    readDirToMap(sessionDir);

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
    page.setDefaultNavigationTimeout(120000);
    page.setDefaultTimeout(120000);

    page.on('pageerror', err => console.log('LOG:[Chromium PageError] ' + err.message));
    page.on('console', msg => {
        const text = msg.text();
        if (msg.type() === 'error' || text.includes('error') || text.includes('Error')) {
            console.log('LOG:[Chromium Console Error] ' + text);
        }
    });
    await page.setViewport({ width: 1920, height: 1080 });

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <script src="https://unpkg.com/three@0.146.0/build/three.min.js"></script>
        <script src="https://unpkg.com/three@0.146.0/examples/js/loaders/GLTFLoader.js"></script>
        <script src="https://unpkg.com/@pixiv/three-vrm@0.6.11/lib/three-vrm.min.js"></script>
        <style>body { margin: 0; overflow: hidden; background: #f8fafc; }</style>
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

            let nextSaccadeTime = 0;
            let saccadeTargetX = 0;
            let saccadeTargetY = 0;
            let saccadeCurrX = 0;
            let saccadeCurrY = 0;

            let smoothedSpeechPitch = 0.0;
            let smoothedSpeechYaw = 0.0;

            // Explicit Camera Presets
            const POS_FULL = new THREE.Vector3(-0.42, 0.82, 3.80);
            const LOOK_FULL = new THREE.Vector3(-0.42, 0.78, 0);

            const POS_MID = new THREE.Vector3(-0.35, 1.08, 2.35);
            const LOOK_MID = new THREE.Vector3(-0.35, 1.05, 0);

            const POS_CLOSE = new THREE.Vector3(-0.22, 1.28, 1.15);
            const LOOK_CLOSE = new THREE.Vector3(-0.22, 1.25, 0);

            function createStudioEnvironment() {
                const floorCanvas = document.createElement('canvas');
                floorCanvas.width = 1024;
                floorCanvas.height = 1024;
                const fCtx = floorCanvas.getContext('2d');

                const fGrad = fCtx.createRadialGradient(512, 512, 80, 512, 512, 500);
                fGrad.addColorStop(0, '#ffffff');
                fGrad.addColorStop(0.70, '#f1f5f9');
                fGrad.addColorStop(1, '#e2e8f0');
                fCtx.fillStyle = fGrad;
                fCtx.fillRect(0, 0, 1024, 1024);

                const floorTex = new THREE.CanvasTexture(floorCanvas);
                const floorGeo = new THREE.PlaneGeometry(30, 30);
                const floorMat = new THREE.MeshBasicMaterial({ map: floorTex });
                const floorMesh = new THREE.Mesh(floorGeo, floorMat);
                floorMesh.rotation.x = -Math.PI / 2;
                floorMesh.position.set(0, 0, 0);
                scene.add(floorMesh);

                const shadowCanvas = document.createElement('canvas');
                shadowCanvas.width = 512;
                shadowCanvas.height = 512;
                const sCtx = shadowCanvas.getContext('2d');

                const sGrad = sCtx.createRadialGradient(256, 256, 25, 256, 256, 230);
                sGrad.addColorStop(0, 'rgba(15, 23, 42, 0.65)');
                sGrad.addColorStop(0.40, 'rgba(30, 41, 59, 0.30)');
                sGrad.addColorStop(0.75, 'rgba(51, 65, 85, 0.08)');
                sGrad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
                sCtx.fillStyle = sGrad;
                sCtx.fillRect(0, 0, 512, 512);

                const sTex = new THREE.CanvasTexture(shadowCanvas);
                const sGeo = new THREE.PlaneGeometry(1.5, 0.95);
                const sMat = new THREE.MeshBasicMaterial({ map: sTex, transparent: true, opacity: 0.85, depthWrite: false });
                const floorShadow = new THREE.Mesh(sGeo, sMat);
                floorShadow.rotation.x = -Math.PI / 2;
                floorShadow.position.set(0.04, 0.002, 0.02);
                scene.add(floorShadow);

                const bgCanvas = document.createElement('canvas');
                bgCanvas.width = 1920;
                bgCanvas.height = 1080;
                const ctx = bgCanvas.getContext('2d');

                const grad = ctx.createLinearGradient(0, 1080, 0, 0);
                grad.addColorStop(0, '#e2e8f0');
                grad.addColorStop(0.40, '#f8fafc');
                grad.addColorStop(1, '#ffffff');
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, 1920, 1080);

                const bgTex = new THREE.CanvasTexture(bgCanvas);
                const bgGeo = new THREE.PlaneGeometry(30, 16);
                const bgMat = new THREE.MeshBasicMaterial({ map: bgTex });
                const bgMesh = new THREE.Mesh(bgGeo, bgMat);
                bgMesh.position.set(0, 6.0, -5.0);
                scene.add(bgMesh);
            }

            function setupOrthographicHUD() {
                hudScene = new THREE.Scene();
                hudCamera = new THREE.OrthographicCamera(0, 1920, 1080, 0, -10, 10);
                hudCamera.position.set(0, 0, 5);
                hudCamera.lookAt(0, 0, 0);

                ltCanvas = document.createElement('canvas');
                ltCanvas.width = 960;
                ltCanvas.height = 160;
                ltContext = ltCanvas.getContext('2d');
                ltTexture = new THREE.CanvasTexture(ltCanvas);

                const geo = new THREE.PlaneGeometry(960, 160);
                ltMat = new THREE.MeshBasicMaterial({ map: ltTexture, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
                lowerThirdMesh = new THREE.Mesh(geo, ltMat);
                lowerThirdMesh.position.set(70 + (960 / 2), 70 + (160 / 2), 1);
                lowerThirdMesh.renderOrder = 100;
                hudScene.add(lowerThirdMesh);

                const overlayInitGeo = new THREE.PlaneGeometry(540, 540);
                overlayMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false });
                overlayMesh = new THREE.Mesh(overlayInitGeo, overlayMat);
                const margin = 70;
                overlayMesh.position.set(margin + (540 / 2), (1080 - margin) - (540 / 2), 1);
                overlayMesh.renderOrder = 90;
                hudScene.add(overlayMesh);
            }

            function renderLowerThirdCanvas(title) {
                ltContext.clearRect(0, 0, 960, 160);

                ltContext.fillStyle = 'rgba(15, 23, 42, 0.95)';
                ltContext.strokeStyle = 'rgba(56, 189, 248, 0.40)';
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
                    antialias: true,
                    stencil: false,
                    depth: true,
                    alpha: false,
                    powerPreference: 'high-performance'
                });
                renderer.setSize(1920, 1080);
                renderer.setPixelRatio(1);
                renderer.setClearColor(0xf8fafc, 1);

                renderer.outputEncoding = THREE.LinearEncoding;
                renderer.toneMapping = THREE.NoToneMapping;
                renderer.autoClear = false;

                scene = new THREE.Scene();
                camera = new THREE.PerspectiveCamera(28, 1920 / 1080, 0.1, 30);
                window.__camera = camera;

                camera.position.copy(POS_FULL);
                window.__camLook = LOOK_FULL.clone();
                camera.lookAt(window.__camLook);
                scene.add(camera);

                createStudioEnvironment();
                setupOrthographicHUD();

                const ambientLight = new THREE.AmbientLight(0xfff8f0, 0.35);
                scene.add(ambientLight);

                const keyLight = new THREE.DirectionalLight(0xffffff, 0.85);
                keyLight.position.set(0.6, 1.8, 2.0).normalize();
                scene.add(keyLight);

                const goldRim = new THREE.DirectionalLight(0xffb703, 1.15);
                goldRim.position.set(-1.8, 1.6, -1.2).normalize();
                scene.add(goldRim);

                const fillRim = new THREE.DirectionalLight(0xffffff, 0.30);
                fillRim.position.set(1.6, 1.3, -1.0).normalize();
                scene.add(fillRim);

                const rawMap = ${JSON.stringify(overlayMap)};
                for (const [key, dataUrl] of Object.entries(rawMap)) {
                    await new Promise((resolve) => {
                        const img = new Image();
                        img.onload = () => {
                            const tex = new THREE.Texture(img);
                            tex.needsUpdate = true;
                            const clean = key.toLowerCase().trim();
                            overlayTextures[clean] = tex;
                            overlayTextures[clean.replace(/\.[^/.]+$/, "")] = tex;
                            resolve();
                        };
                        img.onerror = () => {
                            console.warn("Failed to decode overlay image:", key);
                            resolve();
                        };
                        img.src = dataUrl;
                    });
                }

                const gltfLoader = new THREE.GLTFLoader();
                gltfLoader.load('http://127.0.0.1:${serverPort}/avatar.vrm', (gltf) => {
                    parseFn.call(VRM, gltf).then((loadedVrm) => {
                        vrm = loadedVrm;
                        scene.add(vrm.scene);

                        vrm.scene.rotation.y = Math.PI - 0.08;
                        vrm.scene.position.set(0, 0, 0);

                        vrm.scene.traverse((obj) => {
                            if (obj.isMesh && obj.material) {
                                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                                mats.forEach(m => {
                                    m.toneMapped = false;
                                    if (renderer.capabilities.isWebGL2) {
                                        m.alphaToCoverage = true;
                                    }
                                });
                            }
                        });

                        if (vrm.lookAt) vrm.lookAt.target = null;

                        window.__ready = true;
                    }).catch(err => console.error("VRM initialization error:", err));
                }, undefined, (err) => console.error("GLTF download error:", err));
            }

            function poseFingersCorrect(isLeft, isPointing) {
                const side = isLeft ? 'left' : 'right';

                if (isLeft) {
                    const configs = [
                        { name: 'Index',  ySpread: -0.015, pZ: 0.40, iZ: 0.46, dZ: 0.28 },
                        { name: 'Middle', ySpread:  0.000, pZ: 0.46, iZ: 0.52, dZ: 0.32 },
                        { name: 'Ring',   ySpread:  0.015, pZ: 0.50, iZ: 0.58, dZ: 0.35 },
                        { name: 'Little', ySpread:  0.030, pZ: 0.56, iZ: 0.64, dZ: 0.38 }
                    ];
                    configs.forEach(c => {
                        const p = vrm.humanoid.getBoneNode(side + c.name + 'Proximal');
                        const i = vrm.humanoid.getBoneNode(side + c.name + 'Intermediate');
                        const d = vrm.humanoid.getBoneNode(side + c.name + 'Distal');
                        if (p) p.rotation.set(0.04, c.ySpread, c.pZ);
                        if (i) i.rotation.set(0, 0, c.iZ);
                        if (d) d.rotation.set(0, 0, c.dZ);
                    });
                    const tp = vrm.humanoid.getBoneNode(side + 'ThumbProximal');
                    const ti = vrm.humanoid.getBoneNode(side + 'ThumbIntermediate');
                    const td = vrm.humanoid.getBoneNode(side + 'ThumbDistal');
                    if (tp) tp.rotation.set(0.18, 0.14, 0.24);
                    if (ti) ti.rotation.set(0, 0, 0.20);
                    if (td) td.rotation.set(0, 0, 0.15);
                } else {
                    const configs = [
                        { name: 'Index',  ySpread:  0.015, pZ: isPointing ? 0.00 : -0.40, iZ: isPointing ? 0.00 : -0.46, dZ: isPointing ? 0.00 : -0.28 },
                        { name: 'Middle', ySpread:  0.000, pZ: isPointing ? -0.75 : -0.46, iZ: isPointing ? -0.85 : -0.52, dZ: isPointing ? -0.55 : -0.32 },
                        { name: 'Ring',   ySpread: -0.015, pZ: isPointing ? -0.80 : -0.50, iZ: isPointing ? -0.90 : -0.58, dZ: isPointing ? -0.60 : -0.35 },
                        { name: 'Little', ySpread: -0.030, pZ: isPointing ? -0.85 : -0.56, iZ: isPointing ? -0.95 : -0.64, dZ: isPointing ? -0.65 : -0.38 }
                    ];
                    configs.forEach(c => {
                        const p = vrm.humanoid.getBoneNode(side + c.name + 'Proximal');
                        const i = vrm.humanoid.getBoneNode(side + c.name + 'Intermediate');
                        const d = vrm.humanoid.getBoneNode(side + c.name + 'Distal');
                        if (p) p.rotation.set(0.04, c.ySpread, c.pZ);
                        if (i) i.rotation.set(0, 0, c.iZ);
                        if (d) d.rotation.set(0, 0, c.dZ);
                    });
                    const tp = vrm.humanoid.getBoneNode(side + 'ThumbProximal');
                    const ti = vrm.humanoid.getBoneNode(side + 'ThumbIntermediate');
                    const td = vrm.humanoid.getBoneNode(side + 'ThumbDistal');
                    if (tp) tp.rotation.set(-0.18, 0.14, isPointing ? -0.30 : -0.24);
                    if (ti) ti.rotation.set(0, 0, isPointing ? -0.22 : -0.20);
                    if (td) td.rotation.set(0, 0, isPointing ? -0.16 : -0.15);
                }
            }

            const visemeMap = { 'B': 'i', 'C': 'e', 'D': 'a', 'E': 'u', 'F': 'o', 'G': 'i', 'H': 'a' };

            window.updateFrame = function(t, phoneme, expr, camMode, camAge, activeOverlay, overlayPos, activeGesture, gestAge, ltTitle, ltAge) {
                if (!vrm) return;

                const lerp = (a, b, alpha) => a + (b - a) * alpha;

                const hips = vrm.humanoid.getBoneNode('hips');
                const spine = vrm.humanoid.getBoneNode('spine');
                const chest = vrm.humanoid.getBoneNode('chest');
                const neck = vrm.humanoid.getBoneNode('neck');
                const head = vrm.humanoid.getBoneNode('head');
                const rShoulder = vrm.humanoid.getBoneNode('rightShoulder');
                const lShoulder = vrm.humanoid.getBoneNode('leftShoulder');
                const rArm = vrm.humanoid.getBoneNode('rightUpperArm');
                const rElbow = vrm.humanoid.getBoneNode('rightLowerArm');
                const rHand = vrm.humanoid.getBoneNode('rightHand');
                const lArm = vrm.humanoid.getBoneNode('leftUpperArm');
                const lElbow = vrm.humanoid.getBoneNode('leftLowerArm');
                const lHand = vrm.humanoid.getBoneNode('leftHand');

                const lUpLeg = vrm.humanoid.getBoneNode('leftUpperLeg');
                const lLowLeg = vrm.humanoid.getBoneNode('leftLowerLeg');
                const lFoot = vrm.humanoid.getBoneNode('leftFoot');
                const rUpLeg = vrm.humanoid.getBoneNode('rightUpperLeg');
                const rLowLeg = vrm.humanoid.getBoneNode('rightLowerLeg');
                const rFoot = vrm.humanoid.getBoneNode('rightFoot');

                // Foolproof Camera Matcher (Strict isolation of slowzoom vs zoomout vs close)
                const cam = window.__camera || (typeof camera !== 'undefined' ? camera : null);
                if (cam) {
                    if (!window.__camLook) window.__camLook = LOOK_FULL.clone();

                    const mode = (camMode || '').toLowerCase().trim();

                    let targetPos = POS_FULL;
                    let targetLook = LOOK_FULL;
                    let isSlow = false;

                    if (mode.includes('close') || mode.includes('tight') || mode.includes('face') || mode.includes('chest')) {
                        targetPos = POS_CLOSE;
                        targetLook = LOOK_CLOSE;
                    } else if (mode.includes('slowzoom') || mode.includes('slow zoom')) {
                        isSlow = true;
                        const prog = Math.min(1.0, Math.max(0.0, (camAge || 0) / 2.5));
                        const ease = 0.5 - 0.5 * Math.cos(prog * Math.PI);
                        targetPos = new THREE.Vector3().lerpVectors(POS_FULL, POS_MID, ease);
                        targetLook = new THREE.Vector3().lerpVectors(LOOK_FULL, LOOK_MID, ease);
                    } else if (mode.includes('mid') || mode.includes('medium')) {
                        targetPos = POS_MID;
                        targetLook = LOOK_MID;
                    } else {
                        // Catches default, zoomout, wide, full
                        targetPos = POS_FULL;
                        targetLook = LOOK_FULL;
                    }

                    if (window.__lastMode !== mode) {
                        window.__lastMode = mode;
                        if (!isSlow) {
                            cam.position.copy(targetPos);
                            window.__camLook.copy(targetLook);
                        }
                    }

                    if (isSlow) {
                        cam.position.copy(targetPos);
                        window.__camLook.copy(targetLook);
                    } else {
                        cam.position.lerp(targetPos, 0.40);
                        window.__camLook.lerp(targetLook, 0.40);
                    }

                    cam.lookAt(window.__camLook);
                }

                const breathCycle = Math.sin(t * 1.6);
                const organicSway = (time, f1, f2) => Math.sin(time * f1) * 0.65 + Math.sin(time * f2) * 0.35;

                // Contrapposto Stance
                if (hips) {
                    hips.position.x = 0.018 + organicSway(t, 0.55, 1.1) * 0.005;
                    hips.rotation.z = -0.050 + organicSway(t, 0.45, 0.95) * 0.006;
                    hips.rotation.y = 0.035 + organicSway(t, 0.35, 0.75) * 0.005;
                }
                if (spine) {
                    spine.rotation.x = breathCycle * 0.012;
                    spine.rotation.z = 0.038;
                    spine.rotation.y = -0.025;
                }
                if (chest) {
                    chest.rotation.x = 0.022 + breathCycle * 0.016;
                    chest.rotation.y = -0.018;
                    chest.rotation.z = -0.010;
                }

                if (lUpLeg)  lUpLeg.rotation.set(-0.02, 0.0, -0.02);
                if (lLowLeg) lLowLeg.rotation.set(0.02, 0.0, 0.0);
                if (lFoot)   lFoot.rotation.set(0.0, 0.0, 0.02);

                if (rUpLeg)  rUpLeg.rotation.set(0.06, 0.04, 0.05);
                if (rLowLeg) rLowLeg.rotation.set(-0.10, 0.0, 0.0);
                if (rFoot)   rFoot.rotation.set(0.04, 0.0, -0.04);

                if (rShoulder) rShoulder.rotation.set(0.02, 0.04, 0.03 + breathCycle * 0.006);
                if (lShoulder) lShoulder.rotation.set(-0.02, -0.02, -0.04 - breathCycle * 0.006);

                const isSpeaking = phoneme && phoneme !== 'X';
                const targetSpeechPitch = isSpeaking ? (Math.sin(t * 2.4) * 0.016 + Math.sin(t * 1.2) * 0.010) : (Math.sin(t * 0.9) * 0.005);
                const targetSpeechYaw   = isSpeaking ? (Math.sin(t * 1.6) * 0.012) : 0;

                smoothedSpeechPitch = lerp(smoothedSpeechPitch, targetSpeechPitch, 0.12);
                smoothedSpeechYaw   = lerp(smoothedSpeechYaw, targetSpeechYaw, 0.08);

                const headRoll = -0.030 + organicSway(t, 0.42, 0.85) * 0.010;
                const headYaw  = -0.035 + smoothedSpeechYaw + organicSway(t, 0.35, 0.70) * 0.012;
                const headPitch = -0.040 + smoothedSpeechPitch;

                if (head) head.rotation.set(headPitch, headYaw, headRoll);
                if (neck) neck.rotation.set(headPitch * 0.35, headYaw * 0.30, headRoll * 0.30);

                if (t > nextSaccadeTime) {
                    nextSaccadeTime = t + 2.2 + Math.random() * 2.5;
                    saccadeTargetX = (Math.random() - 0.5) * 0.022;
                    saccadeTargetY = (Math.random() - 0.5) * 0.014;
                }
                saccadeCurrX = lerp(saccadeCurrX, saccadeTargetX, 0.08);
                saccadeCurrY = lerp(saccadeCurrY, saccadeTargetY, 0.08);

                const lEye = vrm.humanoid.getBoneNode('leftEye');
                const rEye = vrm.humanoid.getBoneNode('rightEye');
                if (lEye && rEye) {
                    lEye.rotation.set(saccadeCurrY, saccadeCurrX, 0);
                    rEye.rotation.set(saccadeCurrY, saccadeCurrX, 0);
                }

                // Arm Kinematics: Confirmed Hands-on-Hips Placement
                const hasOverlay = Boolean(activeOverlay);
                const gest = (activeGesture || '').toLowerCase();
                const isGestActive = gest && gestAge <= 2.5;
                const shouldPoint = hasOverlay || (isGestActive && gest.includes('point'));

                if (window.__pointingWeight === undefined) window.__pointingWeight = 0.0;
                window.__pointingWeight = lerp(window.__pointingWeight, shouldPoint ? 1.0 : 0.0, 0.08);
                const pw = window.__pointingWeight;

                // 1. Right Arm: Rest firmly on right hip vs Pointing
                if (rArm && rElbow) {
                    const hipArmX = -0.16 + breathCycle * 0.005;
                    const hipArmY = -0.20;
                    const hipArmZ = -1.24;
                    const hipElbX = -0.92;
                    const hipElbY =  0.35;
                    const hipElbZ = -0.18;

                    const pointArmX = 0.32;
                    const pointArmY = 0.38;
                    const pointArmZ = 0.28;
                    const pointElbX = -0.10;
                    const pointElbY = 0.0;
                    const pointElbZ = 0.0;

                    rArm.rotation.set(
                        lerp(hipArmX, pointArmX, pw),
                        lerp(hipArmY, pointArmY, pw),
                        lerp(hipArmZ, pointArmZ, pw)
                    );
                    rElbow.rotation.set(
                        lerp(hipElbX, pointElbX, pw),
                        lerp(hipElbY, pointElbY, pw),
                        lerp(hipElbZ, pointElbZ, pw)
                    );
                    if (rHand) {
                        rHand.rotation.set(
                            lerp(0.12, 0.0, pw),
                            lerp(0.16, 0.0, pw),
                            lerp(-0.24, 0.0, pw)
                        );
                    }
                }

                // 2. Left Arm: Rest firmly on left hip
                if (lArm)   lArm.rotation.set(-0.16 + breathCycle * 0.005, 0.20, 1.24);
                if (lElbow) lElbow.rotation.set(-0.92, -0.35, 0.18);
                if (lHand)  lHand.rotation.set(0.12, -0.16, 0.24);

                poseFingersCorrect(true, false);
                poseFingersCorrect(false, pw > 0.08);

                if (isGestActive && gest.includes('nod') && head) {
                    head.rotation.x += Math.sin(gestAge * 8.0) * 0.08;
                } else if (isGestActive && (gest.includes('head shake') || gest.includes('shake')) && head) {
                    head.rotation.y += Math.sin(gestAge * 7.0) * 0.12;
                }

                const blinkPeriod = 3.8;
                const blinkMod = t % blinkPeriod;
                let blinkVal = 0;
                if (blinkMod < 0.07) blinkVal = Math.sin((blinkMod / 0.07) * (Math.PI / 2));
                else if (blinkMod < 0.22) blinkVal = Math.cos(((blinkMod - 0.07) / 0.15) * (Math.PI / 2));
                if (vrm.blendShapeProxy) vrm.blendShapeProxy.setValue('blink', blinkVal);

                const targetVowel = visemeMap[phoneme] || null;
                if (targetVowel !== activeViseme) {
                    if (activeViseme) vrm.blendShapeProxy.setValue(activeViseme, 0);
                    if (targetVowel) vrm.blendShapeProxy.setValue(targetVowel, 0.85);
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
                    if (newKey === 'joy') { vrm.blendShapeProxy.setValue('joy', 0.35); vrm.blendShapeProxy.setValue('fun', 0.25); }
                    else if (newKey === 'excited') { vrm.blendShapeProxy.setValue('joy', 0.40); vrm.blendShapeProxy.setValue('fun', 0.40); }
                    else if (newKey === 'angry') vrm.blendShapeProxy.setValue('angry', 0.65);
                    else if (newKey === 'smug') { vrm.blendShapeProxy.setValue('fun', 0.45); vrm.blendShapeProxy.setValue('joy', 0.15); }
                    else if (newKey === 'surprised') vrm.blendShapeProxy.setValue('fun', 0.60);
                    activeEmotionKey = newKey;
                }

                if (activeEmotionKey === 'neutral' && vrm.blendShapeProxy) {
                    vrm.blendShapeProxy.setValue('joy', 0.10);
                    vrm.blendShapeProxy.setValue('fun', 0.16);
                }

                vrm.update(1 / 30);

                const cleanKey = (activeOverlay || '').replace(/['"]/g, '').toLowerCase().trim();
                const cleanBase = cleanKey.replace(/\.[^/.]+$/, "");
                const targetTex = overlayTextures[cleanKey] || overlayTextures[cleanBase];

                if (activeOverlay && targetTex) {
                    if (overlayMat.map !== targetTex) {
                        overlayMat.map = targetTex;
                        overlayMat.needsUpdate = true;
                    }

                    const img = targetTex.image;
                    if (img && img.width > 0 && img.height > 0) {
                        const targetW = 540;
                        const aspect = img.height / img.width;
                        const targetH = targetW * aspect;

                        if (overlayMesh.userData.currentH !== targetH) {
                            overlayMesh.geometry.dispose();
                            overlayMesh.geometry = new THREE.PlaneGeometry(targetW, targetH);
                            const margin = 70;
                            overlayMesh.position.set(margin + (targetW / 2), (1080 - margin) - (targetH / 2), 1);
                            overlayMesh.userData.currentH = targetH;
                        }
                    }
                    overlayMat.opacity = Math.min(1.0, overlayMat.opacity + 0.15);
                } else {
                    overlayMat.opacity = Math.max(0.0, overlayMat.opacity - 0.15);
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
                renderer.clearDepth();
                renderer.render(hudScene, hudCamera);

                return window.__canvas.toDataURL('image/jpeg', 0.85);
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

    await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('window.__ready === true', { timeout: 120000 });

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

            const lastCamEv = timeline.filter(e => e.type === 'cam' && e.time <= (currentTime + 0.005)).pop();
            const activeCam = lastCamEv ? lastCamEv.value : 'default';
            const camAge = lastCamEv ? Math.max(0, currentTime - lastCamEv.time) : 0;

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
