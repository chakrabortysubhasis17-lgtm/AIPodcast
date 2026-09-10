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
        <style>body { margin: 0; overflow: hidden; background: #f5f7fa; }</style>
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

            // VRoid Hub Studio Light Backdrop
            function createStudioBackdrop() {
                const bgCanvas = document.createElement('canvas');
                bgCanvas.width = 1920;
                bgCanvas.height = 1080;
                const ctx = bgCanvas.getContext('2d');

                const grad = ctx.createRadialGradient(960, 480, 150, 960, 540, 1100);
                grad.addColorStop(0, '#ffffff');
                grad.addColorStop(0.55, '#f5f7fa');
                grad.addColorStop(1, '#e8ebf0');
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, 1920, 1080);

                const texture = new THREE.CanvasTexture(bgCanvas);
                const geo = new THREE.PlaneGeometry(12, 6.75);
                const mat = new THREE.MeshBasicMaterial({ map: texture });
                const mesh = new THREE.Mesh(geo, mat);
                mesh.position.set(0, 1.25, -2.5);
                mesh.matrixAutoUpdate = false;
                mesh.updateMatrix();
                scene.add(mesh);
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
                renderer.setClearColor(0xf5f7fa, 1);

                // Disable tone mapping and extra gamma encoding to preserve original MToon colors
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

                // 1. Soft Warm Ambient Fill: Preserves true blacks and dark brown hair
                const ambientLight = new THREE.AmbientLight(0xfff5ee, 0.28);
                scene.add(ambientLight);

                // 2. Front Key Light: Clean cel-shading under chin, bangs, and collar
                const keyLight = new THREE.DirectionalLight(0xffffff, 0.82);
                keyLight.position.set(0.5, 1.6, 1.5).normalize();
                scene.add(keyLight);

                // 3. VRoid Hub Signature Golden Rim: Yellow edge glow along right shoulder and hair
                const goldRim = new THREE.DirectionalLight(0xffb703, 1.15);
                goldRim.position.set(-1.6, 1.4, -1.0).normalize();
                scene.add(goldRim);

                // 4. Subtle Left Shoulder Definition
                const fillRim = new THREE.DirectionalLight(0xffffff, 0.30);
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
                        vrm.scene.rotation.y = Math.PI;
                        vrm.scene.position.set(0, 0, 0);

                        // Ensure materials output direct texture colors
                        vrm.scene.traverse((obj) => {
                            if (obj.isMesh && obj.material) {
                                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                                mats.forEach(m => {
                                    m.toneMapped = false;
                                });
                            }
                        });

                        if (vrm.lookAt) vrm.lookAt.target = null;

                        window.__ready = true;
                    }).catch(err => console.error("VRM initialization error:", err));
                }, undefined, (err) => console.error("GLTF download error:", err));
            }

            const visemeMap = { 'B': 'i', 'C': 'e', 'D': 'a', 'E': 'u', 'F': 'o', 'G': 'i', 'H': 'a' };

            window.updateFrame = function(t, phoneme, expr, camMode, camAge, activeOverlay, overlayPos, activeGesture, gestAge, ltTitle, ltAge) {
                if (!vrm) return;

                const lerp = (a, b, alpha) => a + (b - a) * alpha;

                // --- 1. Bone Targets ---
                const hips = vrm.humanoid.getBoneNode('hips');
                const spine = vrm.humanoid.getBoneNode('spine');
                const chest = vrm.humanoid.getBoneNode('chest');
                const neck = vrm.humanoid.getBoneNode('neck');
                const head = vrm.humanoid.getBoneNode('head');
                const rArm = vrm.humanoid.getBoneNode('rightUpperArm');
                const rElbow = vrm.humanoid.getBoneNode('rightLowerArm');
                const rHand = vrm.humanoid.getBoneNode('rightHand');
                const lArm = vrm.humanoid.getBoneNode('leftUpperArm');
                const lElbow = vrm.humanoid.getBoneNode('leftLowerArm');
                const lHand = vrm.humanoid.getBoneNode('leftHand');

                // --- 2. Camera Framing & Transitions ---
                const cam = window.__camera || (typeof camera !== 'undefined' ? camera : null);
                if (cam) {
                    if (!window.__camLook) window.__camLook = new THREE.Vector3(-0.38, 1.15, 0);

                    const mode = (camMode || '').toLowerCase();
                    const isCloseUp = mode.includes('close') || mode.includes('zoom');
                    const isSlowZoom = mode.includes('slow zoom');

                    // Default Mid Shot: Framed mid-thigh up on right with clean headroom
                    const midPos = new THREE.Vector3(-0.38, 1.18, 2.25);
                    const midLook = new THREE.Vector3(-0.38, 1.15, 0);

                    // Tight Face Close-Up
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

                // --- 3. Body Stance & Weight Shift ---
                const breath = Math.sin(t * 2.1) * 0.018;

                if (hips) {
                    hips.rotation.z = -0.04;
                    hips.position.x = 0.012;
                }
                if (spine) {
                    spine.rotation.x = breath * 0.4;
                    spine.rotation.z = 0.025;
                }
                if (chest) {
                    chest.rotation.x = breath * 0.6;
                }

                // Head: Confident slight chin lift & subtle tilt
                const isSpeaking = phoneme && phoneme !== 'X';
                const nod = isSpeaking ? Math.sin(t * 3.6) * 0.022 : Math.sin(t * 1.1) * 0.008;

                if (head) {
                    head.rotation.set(
                        -0.06 + nod,
                        0.04 + Math.sin(t * 0.6) * 0.015,
                        -0.06 + Math.sin(t * 0.8) * 0.01
                    );
                }
                if (neck) {
                    neck.rotation.set(nod * 0.35, 0.02, -0.02);
                }

                // --- 4. Anatomically Correct Arms & Hands ---
                const hasOverlay = Boolean(activeOverlay);
                const gest = (activeGesture || '').toLowerCase();
                const isGestActive = gest && gestAge <= 2.5;
                const shouldPoint = hasOverlay || (isGestActive && gest.includes('point'));

                if (window.__pointingWeight === undefined) window.__pointingWeight = 0.0;
                window.__pointingWeight = lerp(window.__pointingWeight, shouldPoint ? 1.0 : 0.0, 0.08);
                const pw = window.__pointingWeight;

                // Right Arm (Tattoo): Hand-on-hip pose vs. Pointing towards overlay
                if (rArm && rElbow) {
                    const hipArmX = -0.18 + breath * 0.2;
                    const hipArmY = 0.12;
                    const hipArmZ = -1.18;
                    const hipElbX = -1.25;
                    const hipElbY = 0.0;
                    const hipElbZ = -0.08;

                    const pointArmX = 0.45;
                    const pointArmY = 0.40;
                    const pointArmZ = -0.65;
                    const pointElbX = -0.30;
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
                            lerp(0.0, 0.0, pw),
                            lerp(0.18, -0.15, pw)
                        );
                    }
                }

                // Left Arm (Wristband): Relaxed along side, palm facing thigh, thumb forward
                if (lArm) {
                    lArm.rotation.set(0.08 + breath * 0.2, 0.0, 1.25);
                }
                if (lElbow) {
                    lElbow.rotation.set(0.18, 0.0, 0.0);
                }
                if (lHand) {
                    lHand.rotation.set(-0.05, 0.0, 0.0);
                }

                // --- 5. Natural Finger Curls ---
                const fingerBones = ['Index', 'Middle', 'Ring', 'Little'];

                fingerBones.forEach(f => {
                    const p = vrm.humanoid.getBoneNode('left' + f + 'Proximal');
                    const i = vrm.humanoid.getBoneNode('left' + f + 'Intermediate');
                    const d = vrm.humanoid.getBoneNode('left' + f + 'Distal');
                    if (p) p.rotation.z = -0.22;
                    if (i) i.rotation.z = -0.28;
                    if (d) d.rotation.z = -0.18;
                });
                const ltp = vrm.humanoid.getBoneNode('leftThumbProximal');
                if (ltp) ltp.rotation.set(0.10, -0.10, -0.10);

                const rCurl = lerp(0.24, 0.06, pw);
                fingerBones.forEach(f => {
                    const p = vrm.humanoid.getBoneNode('right' + f + 'Proximal');
                    const i = vrm.humanoid.getBoneNode('right' + f + 'Intermediate');
                    const d = vrm.humanoid.getBoneNode('right' + f + 'Distal');
                    if (p) p.rotation.z = rCurl;
                    if (i) i.rotation.z = rCurl * 1.1;
                    if (d) d.rotation.z = rCurl * 0.8;
                });
                const rtp = vrm.humanoid.getBoneNode('rightThumbProximal');
                if (rtp) rtp.rotation.set(-0.12, 0.10, rCurl * 0.4);

                // Head Gestures
                if (isGestActive && gest.includes('nod') && head) {
                    head.rotation.x += Math.sin(gestAge * 9.0) * 0.10;
                } else if (isGestActive && (gest.includes('head shake') || gest.includes('shake')) && head) {
                    head.rotation.y += Math.sin(gestAge * 8.0) * 0.14;
                }

                // --- 6. Natural Blinking & Facial Presence ---
                const blinkCycle = t % 3.6;
                const blinkVal = blinkCycle < 0.16 ? Math.sin((blinkCycle / 0.16) * Math.PI) : 0;
                if (vrm.blendShapeProxy) {
                    vrm.blendShapeProxy.setValue('blink', blinkVal);
                }

                // --- 7. Lip Sync & Expression ---
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

                // --- 8. HUD Graphic Overlay (Left Side Space) ---
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

                // --- 9. Lower-Third Dynamic Graphic Banner ---
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
