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

            function createStudioBackdrop() {
                const bgCanvas = document.createElement('canvas');
                bgCanvas.width = 1920;
                bgCanvas.height = 1080;
                const ctx = bgCanvas.getContext('2d');

                const grad = ctx.createRadialGradient(960, 480, 160, 960, 540, 1100);
                grad.addColorStop(0, '#ffffff');
                grad.addColorStop(0.60, '#f8fafc');
                grad.addColorStop(1, '#e9edf3');
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, 1920, 1080);

                const texture = new THREE.CanvasTexture(bgCanvas);
                const geo = new THREE.PlaneGeometry(14, 8);
                const mat = new THREE.MeshBasicMaterial({ map: texture });
                const mesh = new THREE.Mesh(geo, mat);
                mesh.position.set(0, 1.25, -2.5);
                mesh.matrixAutoUpdate = false;
                mesh.updateMatrix();
                scene.add(mesh);

                const shadowCanvas = document.createElement('canvas');
                shadowCanvas.width = 512;
                shadowCanvas.height = 512;
                const sCtx = shadowCanvas.getContext('2d');
                const sGrad = sCtx.createRadialGradient(256, 256, 10, 256, 256, 240);
                sGrad.addColorStop(0, 'rgba(30, 41, 59, 0.35)');
                sGrad.addColorStop(0.4, 'rgba(51, 65, 85, 0.15)');
                sGrad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
                sCtx.fillStyle = sGrad;
                sCtx.fillRect(0, 0, 512, 512);

                const sTex = new THREE.CanvasTexture(shadowCanvas);
                const sGeo = new THREE.PlaneGeometry(1.6, 1.6);
                const sMat = new THREE.MeshBasicMaterial({ map: sTex, transparent: true, opacity: 0.85 });
                const floorShadow = new THREE.Mesh(sGeo, sMat);
                floorShadow.rotation.x = -Math.PI / 2;
                floorShadow.position.set(0, 0.005, 0);
                scene.add(floorShadow);
            }

            function setupOrthographicHUD() {
                hudScene = new THREE.Scene();
                hudCamera = new THREE.OrthographicCamera(0, 1920, 1080, 0, -10, 10);

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

                const overlayInitGeo = new THREE.PlaneGeometry(540, 540);
                overlayMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
                overlayMesh = new THREE.Mesh(overlayInitGeo, overlayMat);
                const initialMargin = 60;
                overlayMesh.position.set(initialMargin + (540 / 2), (1080 - initialMargin) - (540 / 2), 2);
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
                camera = new THREE.PerspectiveCamera(28, 1920 / 1080, 0.1, 20);
                window.__camera = camera;

                camera.position.set(-0.38, 1.18, 2.25);
                window.__camLook = new THREE.Vector3(-0.38, 1.15, 0);
                camera.lookAt(window.__camLook);
                scene.add(camera);

                createStudioBackdrop();
                setupOrthographicHUD();

                const ambientLight = new THREE.AmbientLight(0xfff5ee, 0.28);
                scene.add(ambientLight);

                const keyLight = new THREE.DirectionalLight(0xffffff, 0.82);
                keyLight.position.set(0.5, 1.6, 1.5).normalize();
                scene.add(keyLight);

                const goldRim = new THREE.DirectionalLight(0xffb703, 1.2);
                goldRim.position.set(-1.6, 1.4, -1.0).normalize();
                scene.add(goldRim);

                const fillRim = new THREE.DirectionalLight(0xffffff, 0.28);
                fillRim.position.set(1.5, 1.2, -0.8).normalize();
                scene.add(fillRim);

                const textureLoader = new THREE.TextureLoader();
                const rawMap = ${JSON.stringify(overlayMap)};
                for (const [key, dataUrl] of Object.entries(rawMap)) {
                    overlayTextures[key] = textureLoader.load(dataUrl);
                }

                const gltfLoader = new THREE.GLTFLoader();
                gltfLoader.load('http://127.0.0.1:${serverPort}/avatar.vrm', (gltf) => {
                    parseFn.call(VRM, gltf).then((loadedVrm) => {
                        vrm = loadedVrm;
                        scene.add(vrm.scene);

                        // Halved angle: precisely 5.7° (0.10 rad) from perpendicular
                        vrm.scene.rotation.y = Math.PI - 0.10;
                        vrm.scene.position.set(0, 0, 0);

                        vrm.scene.traverse((obj) => {
                            if (obj.isMesh && obj.material) {
                                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                                mats.forEach(m => { m.toneMapped = false; });
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
                        { name: 'Index',  ySpread: -0.04, pZ: -0.24, iZ: -0.32, dZ: -0.20 },
                        { name: 'Middle', ySpread:  0.00, pZ: -0.34, iZ: -0.40, dZ: -0.24 },
                        { name: 'Ring',   ySpread:  0.05, pZ: -0.42, iZ: -0.48, dZ: -0.28 },
                        { name: 'Little', ySpread:  0.10, pZ: -0.50, iZ: -0.56, dZ: -0.34 }
                    ];
                    configs.forEach(c => {
                        const p = vrm.humanoid.getBoneNode(side + c.name + 'Proximal');
                        const i = vrm.humanoid.getBoneNode(side + c.name + 'Intermediate');
                        const d = vrm.humanoid.getBoneNode(side + c.name + 'Distal');
                        if (p) p.rotation.set(0, c.ySpread, c.pZ);
                        if (i) i.rotation.set(0, 0, c.iZ);
                        if (d) d.rotation.set(0, 0, c.dZ);
                    });
                    const tp = vrm.humanoid.getBoneNode(side + 'ThumbProximal');
                    const ti = vrm.humanoid.getBoneNode(side + 'ThumbIntermediate');
                    const td = vrm.humanoid.getBoneNode(side + 'ThumbDistal');
                    if (tp) tp.rotation.set(-0.10, -0.18, -0.15);
                    if (ti) ti.rotation.set(0, 0, -0.12);
                    if (td) td.rotation.set(0, 0, -0.08);
                } else {
                    const configs = [
                        { name: 'Index',  ySpread:  0.04, pZ: isPointing ? 0.04 : 0.26, iZ: isPointing ? 0.02 : 0.32, dZ: isPointing ? 0.00 : 0.20 },
                        { name: 'Middle', ySpread:  0.00, pZ: isPointing ? 0.75 : 0.36, iZ: isPointing ? 0.85 : 0.40, dZ: isPointing ? 0.55 : 0.24 },
                        { name: 'Ring',   ySpread: -0.05, pZ: isPointing ? 0.82 : 0.44, iZ: isPointing ? 0.90 : 0.48, dZ: isPointing ? 0.60 : 0.28 },
                        { name: 'Little', ySpread: -0.10, pZ: isPointing ? 0.88 : 0.52, iZ: isPointing ? 0.95 : 0.56, dZ: isPointing ? 0.65 : 0.34 }
                    ];
                    configs.forEach(c => {
                        const p = vrm.humanoid.getBoneNode(side + c.name + 'Proximal');
                        const i = vrm.humanoid.getBoneNode(side + c.name + 'Intermediate');
                        const d = vrm.humanoid.getBoneNode(side + c.name + 'Distal');
                        if (p) p.rotation.set(0, c.ySpread, c.pZ);
                        if (i) i.rotation.set(0, 0, c.iZ);
                        if (d) d.rotation.set(0, 0, c.dZ);
                    });
                    const tp = vrm.humanoid.getBoneNode(side + 'ThumbProximal');
                    const ti = vrm.humanoid.getBoneNode(side + 'ThumbIntermediate');
                    const td = vrm.humanoid.getBoneNode(side + 'ThumbDistal');
                    if (tp) tp.rotation.set(-0.10, 0.18, isPointing ? 0.35 : 0.18);
                    if (ti) ti.rotation.set(0, 0, isPointing ? 0.25 : 0.14);
                    if (td) td.rotation.set(0, 0, isPointing ? 0.18 : 0.10);
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

                const cam = window.__camera || (typeof camera !== 'undefined' ? camera : null);
                if (cam) {
                    if (!window.__camLook) window.__camLook = new THREE.Vector3(-0.38, 1.15, 0);

                    const mode = (camMode || '').toLowerCase();
                    const isCloseUp = mode.includes('close') || mode.includes('zoom');
                    const isSlowZoom = mode.includes('slow zoom');

                    const midPos = new THREE.Vector3(-0.38, 1.18, 2.25);
                    const midLook = new THREE.Vector3(-0.38, 1.15, 0);

                    const closePos = new THREE.Vector3(-0.10, 1.36, 1.15);
                    const closeLook = new THREE.Vector3(-0.10, 1.36, 0);

                    let targetCamPos = midPos.clone();
                    let targetCamLook = midLook.clone();

                    if (isSlowZoom) {
                        const zoomProg = Math.min(1.0, (camAge || 0) / 4.5);
                        targetCamPos.lerpVectors(midPos, closePos, zoomProg);
                        targetCamLook.lerpVectors(midLook, closeLook, zoomProg);
                    } else if (isCloseUp) {
                        targetCamPos.copy(closePos);
                        targetCamLook.copy(closeLook);
                    }

                    if (mode.includes('shake')) {
                        const shakeMag = Math.max(0, 0.02 * (1.0 - ((camAge || 0) / 0.7)));
                        targetCamPos.x += (Math.random() - 0.5) * shakeMag;
                        targetCamPos.y += (Math.random() - 0.5) * shakeMag;
                    }

                    cam.position.lerp(targetCamPos, 0.07);
                    window.__camLook.lerp(targetCamLook, 0.07);
                    cam.lookAt(window.__camLook);
                }

                const organicSway = (time, f1, f2, f3) => {
                    return Math.sin(time * f1) * 0.55 + Math.sin(time * f2) * 0.32 + Math.sin(time * f3) * 0.13;
                };

                const tHips = t;
                const tSpine = t - 0.15;
                const tHead = t - 0.35;

                const hipSwayX = organicSway(tHips, 0.72, 1.35, 2.81) * 0.016;
                const hipRollZ = organicSway(tHips, 0.68, 1.25, 2.50) * 0.024;
                const breathCycle = Math.sin(t * 1.96);

                if (hips) {
                    hips.position.x = 0.012 + hipSwayX;
                    hips.rotation.z = -0.042 + hipRollZ;
                    hips.rotation.y = organicSway(tHips, 0.45, 0.95, 1.7) * 0.018;
                }
                if (spine) {
                    spine.rotation.x = breathCycle * 0.018 + organicSway(tSpine, 0.5, 1.1, 2.1) * 0.008;
                    spine.rotation.z = 0.028 - hipRollZ * 0.65;
                    spine.rotation.y = organicSway(tSpine, 0.4, 0.8, 1.6) * 0.012;
                }
                if (chest) {
                    chest.rotation.x = breathCycle * 0.026;
                    // Halved chest inward rotation
                    chest.rotation.y = -0.04 + organicSway(tSpine, 0.35, 0.75, 1.5) * 0.015;
                }

                if (rShoulder) rShoulder.rotation.set(0.04, 0.06, 0.08 + breathCycle * 0.01);
                if (lShoulder) lShoulder.rotation.set(-0.02, 0.0, -0.03 - breathCycle * 0.008);

                const isSpeaking = phoneme && phoneme !== 'X';
                const nod = isSpeaking ? (Math.sin(t * 3.8) * 0.024 + Math.sin(t * 7.2) * 0.01) : (Math.sin(t * 1.1) * 0.008);

                // Halved head yaw (-0.07 rad) maintains direct eye line with audience
                const headRoll = -0.05 + organicSway(tHead, 0.52, 1.05, 2.2) * 0.018;
                const headYaw = -0.07 + organicSway(tHead, 0.42, 0.88, 1.75) * 0.022;
                const headPitch = -0.06 + nod + organicSway(tHead, 0.65, 1.3, 2.6) * 0.012;

                if (head) head.rotation.set(headPitch, headYaw, headRoll);
                if (neck) neck.rotation.set(nod * 0.35 + headPitch * 0.25, headYaw * 0.25, headRoll * 0.25);

                if (t > nextSaccadeTime) {
                    nextSaccadeTime = t + 1.8 + Math.random() * 2.0;
                    saccadeTargetX = (Math.random() - 0.5) * 0.028;
                    saccadeTargetY = (Math.random() - 0.5) * 0.018;
                }
                saccadeCurrX = lerp(saccadeCurrX, saccadeTargetX, 0.10);
                saccadeCurrY = lerp(saccadeCurrY, saccadeTargetY, 0.10);

                const lEye = vrm.humanoid.getBoneNode('leftEye');
                const rEye = vrm.humanoid.getBoneNode('rightEye');
                if (lEye && rEye) {
                    lEye.rotation.set(saccadeCurrY, saccadeCurrX, 0);
                    rEye.rotation.set(saccadeCurrY, saccadeCurrX, 0);
                }

                const hasOverlay = Boolean(activeOverlay);
                const gest = (activeGesture || '').toLowerCase();
                const isGestActive = gest && gestAge <= 2.5;
                const shouldPoint = hasOverlay || (isGestActive && gest.includes('point'));

                if (window.__pointingWeight === undefined) window.__pointingWeight = 0.0;
                window.__pointingWeight = lerp(window.__pointingWeight, shouldPoint ? 1.0 : 0.0, 0.08);
                const pw = window.__pointingWeight;

                if (rArm && rElbow) {
                    const hipArmX = -0.28 + breathCycle * 0.008;
                    const hipArmY = -0.15;
                    const hipArmZ = -1.18;
                    const hipElbX = -0.92;
                    const hipElbY = 0.0;
                    const hipElbZ = -0.05;

                    const pointArmX = 0.45;
                    const pointArmY = 0.42;
                    const pointArmZ = -0.65;
                    const pointElbX = -0.32;
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
                            lerp(0.10, 0.0, pw),
                            lerp(-0.15, 0.0, pw),
                            lerp(-0.20, -0.12, pw)
                        );
                    }
                }

                if (lArm) lArm.rotation.set(0.04 + breathCycle * 0.006, 0.0, 1.30);
                if (lElbow) lElbow.rotation.set(0.08, 0.0, 0.0);
                if (lHand) lHand.rotation.set(0.0, 0.0, 0.0);

                poseFingersCorrect(true, false);
                poseFingersCorrect(false, pw > 0.05);

                if (isGestActive && gest.includes('nod') && head) {
                    head.rotation.x += Math.sin(gestAge * 9.0) * 0.10;
                } else if (isGestActive && (gest.includes('head shake') || gest.includes('shake')) && head) {
                    head.rotation.y += Math.sin(gestAge * 8.0) * 0.14;
                }

                const blinkPeriod = 3.8;
                const blinkMod = t % blinkPeriod;
                let blinkVal = 0;
                if (blinkMod < 0.08) blinkVal = blinkMod / 0.08;
                else if (blinkMod < 0.24) blinkVal = 1.0 - ((blinkMod - 0.08) / 0.16);
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

                if (activeOverlay && overlayTextures[activeOverlay.toLowerCase()]) {
                    const tex = overlayTextures[activeOverlay.toLowerCase()];
                    if (overlayMat.map !== tex) {
                        overlayMat.map = tex;
                        overlayMat.needsUpdate = true;
                    }

                    const img = tex.image;
                    if (img && img.width > 0 && img.height > 0) {
                        const targetW = 540;
                        const aspect = img.height / img.width;
                        const targetH = targetW * aspect;

                        if (overlayMesh.userData.currentH !== targetH) {
                            overlayMesh.geometry.dispose();
                            overlayMesh.geometry = new THREE.PlaneGeometry(targetW, targetH);
                            const margin = 60;
                            overlayMesh.position.set(margin + (targetW / 2), (1080 - margin) - (targetH / 2), 2);
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
