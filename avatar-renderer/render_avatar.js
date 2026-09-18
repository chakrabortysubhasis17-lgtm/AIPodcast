import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDaemonMode = process.argv[2] === '--daemon';
const daemonPort = parseInt(process.argv[3] || '5055', 10);

const readJsonClean = (p) => {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw.trim());
};

const BATCH_SIZE = 90;

const readDirToMap = (dir, map) => {
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
                    map[key] = dataUri;
                    map[key.replace(/\.[^/.]+$/, "")] = dataUri;
                }
            }
        }
    }
};

const createHtmlContent = (avatarPath) => `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>body { margin: 0; overflow: hidden; background: #f8fafc; }</style>
    <script type="importmap">
    {
        "imports": {
            "three": "/node_modules/three/build/three.module.js",
            "three/addons/": "/node_modules/three/examples/jsm/",
            "@pixiv/three-vrm": "/node_modules/@pixiv/three-vrm/lib/three-vrm.module.js",
            "@pixiv/three-vrm-animation": "/node_modules/@pixiv/three-vrm-animation/lib/three-vrm-animation.module.js"
        }
    }
    </script>
</head>
<body>
    <canvas id="canvas" width="1280" height="720"></canvas>
    <script type="module">
        import * as THREE from 'three';
        import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
        import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

        let renderer, scene, camera, vrm;
        let hudScene, hudCamera;
        let overlayMesh, overlayMat;
        let lowerThirdMesh, ltMat, ltCanvas, ltContext, ltTexture;
        let overlayTextures = {};
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

        let avatarHeadY = 1.35;
        let avatarHeightDelta = 0.0;

        const PERSONA_VRM0 = {
            breathFreq: 1.75, breathAmp: 0.016, weightShiftPeriod: 8.5,
            hipSwayAmp: 0.007, hipTiltBase: -0.045, hipTiltAmp: 0.012,
            spineTilt: 0.035, headRollBias: -0.038, headRollAmp: 0.014,
            headPitchBias: -0.025, saccadeIntervalMin: 1.8, saccadeIntervalVar: 2.2,
            blinkPeriod: 3.5, baselineJoy: 0.18, baselineFun: 0.22
        };

        const PERSONA_VRM1 = {
            breathFreq: 1.45, breathAmp: 0.011, weightShiftPeriod: 14.0,
            hipSwayAmp: 0.003, hipTiltBase: -0.025, hipTiltAmp: 0.006,
            spineTilt: 0.018, headRollBias: -0.018, headRollAmp: 0.007,
            headPitchBias: -0.040, saccadeIntervalMin: 3.4, saccadeIntervalVar: 3.0,
            blinkPeriod: 4.2, baselineJoy: 0.06, baselineFun: 0.08
        };

        const POS_FULL = new THREE.Vector3(-0.42, 0.82, 3.80);
        const LOOK_FULL = new THREE.Vector3(-0.42, 0.78, 0);
        const POS_MID = new THREE.Vector3(-0.35, 1.08, 2.35);
        const LOOK_MID = new THREE.Vector3(-0.35, 1.05, 0);
        const POS_CLOSE = new THREE.Vector3(-0.22, 1.28, 1.15);
        const LOOK_CLOSE = new THREE.Vector3(-0.22, 1.25, 0);

        function createStudioEnvironment() {
            const floorCanvas = document.createElement('canvas');
            floorCanvas.width = 1024; floorCanvas.height = 1024;
            const fCtx = floorCanvas.getContext('2d');
            const fGrad = fCtx.createRadialGradient(512, 512, 80, 512, 512, 500);
            fGrad.addColorStop(0, '#ffffff'); fGrad.addColorStop(0.70, '#f1f5f9'); fGrad.addColorStop(1, '#e2e8f0');
            fCtx.fillStyle = fGrad; fCtx.fillRect(0, 0, 1024, 1024);
            const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(floorCanvas) }));
            floorMesh.rotation.x = -Math.PI / 2;
            scene.add(floorMesh);

            const shadowCanvas = document.createElement('canvas');
            shadowCanvas.width = 512; shadowCanvas.height = 512;
            const sCtx = shadowCanvas.getContext('2d');
            const sGrad = sCtx.createRadialGradient(256, 256, 25, 256, 256, 230);
            sGrad.addColorStop(0, 'rgba(15, 23, 42, 0.55)'); sGrad.addColorStop(0.40, 'rgba(30, 41, 59, 0.25)');
            sGrad.addColorStop(0.75, 'rgba(51, 65, 85, 0.06)'); sGrad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
            sCtx.fillStyle = sGrad; sCtx.fillRect(0, 0, 512, 512);
            const floorShadow = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.95), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shadowCanvas), transparent: true, opacity: 0.85, depthWrite: false }));
            floorShadow.rotation.x = -Math.PI / 2; floorShadow.position.set(0.04, 0.002, 0.02);
            scene.add(floorShadow);

            const bgCanvas = document.createElement('canvas');
            bgCanvas.width = 1920; bgCanvas.height = 1080;
            const ctx = bgCanvas.getContext('2d');
            const grad = ctx.createLinearGradient(0, 1080, 0, 0);
            grad.addColorStop(0, '#e2e8f0'); grad.addColorStop(0.40, '#f8fafc'); grad.addColorStop(1, '#ffffff');
            ctx.fillStyle = grad; ctx.fillRect(0, 0, 1920, 1080);
            const bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(30, 16), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(bgCanvas) }));
            bgMesh.position.set(0, 6.0, -5.0);
            scene.add(bgMesh);
        }

        function setupOrthographicHUD() {
            hudScene = new THREE.Scene();
            hudCamera = new THREE.OrthographicCamera(0, 1920, 1080, 0, -10, 10);
            hudCamera.position.set(0, 0, 5); hudCamera.lookAt(0, 0, 0);

            ltCanvas = document.createElement('canvas');
            ltCanvas.width = 960; ltCanvas.height = 160;
            ltContext = ltCanvas.getContext('2d');
            ltTexture = new THREE.CanvasTexture(ltCanvas);
            ltMat = new THREE.MeshBasicMaterial({ map: ltTexture, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
            lowerThirdMesh = new THREE.Mesh(new THREE.PlaneGeometry(960, 160), ltMat);
            lowerThirdMesh.position.set(70 + (960 / 2), 70 + (160 / 2), 1);
            lowerThirdMesh.renderOrder = 100;
            hudScene.add(lowerThirdMesh);

            overlayMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false });
            overlayMesh = new THREE.Mesh(new THREE.PlaneGeometry(540, 540), overlayMat);
            overlayMesh.position.set(70 + 270, (1080 - 70) - 270, 1);
            overlayMesh.renderOrder = 90;
            hudScene.add(overlayMesh);
        }

        function renderLowerThirdCanvas(title) {
            ltContext.clearRect(0, 0, 960, 160);
            ltContext.fillStyle = 'rgba(15, 23, 42, 0.95)';
            ltContext.strokeStyle = 'rgba(56, 189, 248, 0.40)';
            ltContext.lineWidth = 3;
            ltContext.beginPath(); ltContext.roundRect(10, 10, 940, 140, [14]); ltContext.fill(); ltContext.stroke();

            const barGrad = ltContext.createLinearGradient(12, 12, 12, 148);
            barGrad.addColorStop(0, '#e11d48'); barGrad.addColorStop(1, '#f59e0b');
            ltContext.fillStyle = barGrad; ltContext.beginPath(); ltContext.roundRect(12, 12, 10, 136, [6, 0, 0, 6]); ltContext.fill();

            ltContext.fillStyle = '#e11d48'; ltContext.beginPath(); ltContext.roundRect(38, 28, 145, 28, [6]); ltContext.fill();
            ltContext.fillStyle = '#ffffff'; ltContext.font = 'bold 15px sans-serif'; ltContext.fillText('BEINGABONG', 50, 48);

            ltContext.fillStyle = '#f8fafc'; ltContext.font = 'bold 32px sans-serif';
            const clean = (title || '').replace(/\\[.*?\\]/g, '').trim();
            ltContext.fillText(clean.length > 48 ? clean.substring(0, 45) + '...' : clean, 38, 102);

            ltContext.fillStyle = '#38bdf8'; ltContext.font = '600 14px monospace'; ltContext.fillText('SPECIAL BROADCAST FEATURE', 38, 132);
            ltTexture.needsUpdate = true;
        }

        window.loadOverlays = async function(rawMap) {
            overlayTextures = {};
            for (const [key, dataUrl] of Object.entries(rawMap)) {
                await new Promise((res) => {
                    const img = new Image();
                    img.onload = () => {
                        const tex = new THREE.Texture(img);
                        tex.needsUpdate = true;
                        const clean = key.toLowerCase().trim();
                        overlayTextures[clean] = tex;
                        overlayTextures[clean.replace(/\\.[^/.]+$/, "")] = tex;
                        res();
                    };
                    img.onerror = () => res();
                    img.src = dataUrl;
                });
            }
        };

        window.loadAvatarModel = function(modelUrl) {
            return new Promise((resolve, reject) => {
                if (vrm) { scene.remove(vrm.scene); vrm = null; }
                const gltfLoader = new GLTFLoader();
                gltfLoader.register((p) => new VRMLoaderPlugin(p));
                gltfLoader.load(modelUrl, (gltf) => {
                    const loadedVrm = gltf.userData.vrm;
                    if (VRMUtils?.removeUnnecessaryVertices) VRMUtils.removeUnnecessaryVertices(gltf.scene);
                    if (VRMUtils?.removeUnnecessaryJoints) VRMUtils.removeUnnecessaryJoints(gltf.scene);
                    vrm = loadedVrm;
                    scene.add(vrm.scene);

                    const isVRM0 = Boolean(vrm.meta && vrm.meta.metaVersion === '0');
                    window.__isVRM0 = isVRM0;
                    if (isVRM0 && VRMUtils?.rotateVRM0) VRMUtils.rotateVRM0(vrm);
                    vrm.scene.rotation.y = isVRM0 ? (Math.PI - 0.08) : -0.06;

                    const rawGetNormalized = vrm.humanoid?.getNormalizedBoneNode?.bind(vrm.humanoid);
                    const rawGetBone = vrm.humanoid?.getBoneNode?.bind(vrm.humanoid);
                    if (vrm.humanoid) {
                        vrm.humanoid.getBoneNode = function(name) {
                            let node = rawGetNormalized ? rawGetNormalized(name) : null;
                            if (!node && rawGetBone) node = rawGetBone(name);
                            if (!node) {
                                if (name.endsWith('ThumbProximal')) {
                                    const alt = name.replace('ThumbProximal', 'ThumbMetacarpal');
                                    node = (rawGetNormalized && rawGetNormalized(alt)) || (rawGetBone && rawGetBone(alt));
                                } else if (name.endsWith('ThumbIntermediate')) {
                                    const alt = name.replace('ThumbIntermediate', 'ThumbProximal');
                                    node = (rawGetNormalized && rawGetNormalized(alt)) || (rawGetBone && rawGetBone(alt));
                                }
                            }
                            return node;
                        };
                    }

                    const headBone = vrm.humanoid?.getBoneNode('head');
                    if (headBone) {
                        const hPos = new THREE.Vector3();
                        headBone.getWorldPosition(hPos);
                        avatarHeadY = hPos.y;
                        avatarHeightDelta = isVRM0 ? 0.0 : (avatarHeadY - 1.35);
                    }

                    const EXPR_MAP = { 'a':'aa','i':'ih','u':'ou','e':'ee','o':'oh','joy':'happy','fun':'relaxed','sorrow':'sad','aa':'a','ih':'i','ou':'u','ee':'e','oh':'o','happy':'joy','relaxed':'fun','sad':'sorrow' };
                    if (!vrm.blendShapeProxy && vrm.expressionManager) {
                        vrm.blendShapeProxy = {
                            setValue: (n, v) => {
                                const val = Math.max(0, Math.min(1, v));
                                try { vrm.expressionManager.setValue(n, val); } catch (_) {}
                                const alt = EXPR_MAP[n];
                                if (alt) { try { vrm.expressionManager.setValue(alt, val); } catch (_) {} }
                            },
                            getValue: (n) => { try { return vrm.expressionManager.getValue(n) || 0; } catch (_) { return 0; } }
                        };
                    }

                    vrm.scene.traverse((obj) => {
                        if (obj.isMesh && obj.material) {
                            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                            mats.forEach(m => { m.toneMapped = true; });
                        }
                    });
                    if (vrm.lookAt) { vrm.lookAt.target = null; vrm.lookAt.autoUpdate = false; }
                    resolve();
                }, undefined, reject);
            });
        };

        async function init() {
            const canvas = document.getElementById('canvas');
            window.__canvas = canvas;
            renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: false, depth: true, alpha: false, powerPreference: 'high-performance' });
            renderer.setSize(1280, 720);
            renderer.setPixelRatio(1);
            renderer.outputColorSpace = THREE.SRGBColorSpace;
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.toneMappingExposure = 0.95;
            renderer.autoClear = false;

            scene = new THREE.Scene();
            camera = new THREE.PerspectiveCamera(28, 1280 / 720, 0.1, 30);
            window.__camera = camera;
            camera.position.copy(POS_FULL);
            window.__camLook = LOOK_FULL.clone();
            camera.lookAt(window.__camLook);
            scene.add(camera);

            createStudioEnvironment();
            setupOrthographicHUD();

            scene.add(new THREE.AmbientLight(0xffffff, 0.55));
            const keyLight = new THREE.DirectionalLight(0xfff5ea, 0.90);
            keyLight.position.set(0.6, 2.0, 2.2).normalize();
            scene.add(keyLight);
            const rimLight = new THREE.DirectionalLight(0xffffff, 0.45);
            rimLight.position.set(-1.8, 1.8, -1.2).normalize();
            scene.add(rimLight);

            await window.loadAvatarModel('/avatar.vrm');
            window.__ready = true;
        }

        function poseFingersCorrect(isLeft, isPointing) {
            const isVRM0 = window.__isVRM0;
            const side = isLeft ? 'left' : 'right';
            if (isVRM0) {
                if (isLeft) {
                    const configs = [
                        { name: 'Index', ySpread: -0.015, pZ: 0.40, iZ: 0.46, dZ: 0.28 },
                        { name: 'Middle', ySpread: 0.000, pZ: 0.46, iZ: 0.52, dZ: 0.32 },
                        { name: 'Ring', ySpread: 0.015, pZ: 0.50, iZ: 0.58, dZ: 0.35 },
                        { name: 'Little', ySpread: 0.030, pZ: 0.56, iZ: 0.64, dZ: 0.38 }
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
                        { name: 'Index', ySpread: 0.015, pZ: isPointing ? 0.00 : -0.40, iZ: isPointing ? 0.00 : -0.46, dZ: isPointing ? 0.00 : -0.28 },
                        { name: 'Middle', ySpread: 0.000, pZ: isPointing ? -0.75 : -0.46, iZ: isPointing ? -0.85 : -0.52, dZ: isPointing ? -0.55 : -0.32 },
                        { name: 'Ring', ySpread: -0.015, pZ: isPointing ? -0.80 : -0.50, iZ: isPointing ? -0.90 : -0.58, dZ: isPointing ? -0.60 : -0.35 },
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
            } else {
                if (isLeft) {
                    const configs = [
                        { name: 'Index', ySpread: -0.015, pZ: -0.35, iZ: -0.40, dZ: -0.25 },
                        { name: 'Middle', ySpread: 0.000, pZ: -0.40, iZ: -0.45, dZ: -0.28 },
                        { name: 'Ring', ySpread: 0.015, pZ: -0.44, iZ: -0.50, dZ: -0.30 },
                        { name: 'Little', ySpread: 0.030, pZ: -0.48, iZ: -0.55, dZ: -0.32 }
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
                    if (tp) tp.rotation.set(0.15, 0.12, -0.20);
                    if (ti) ti.rotation.set(0, 0, -0.16);
                    if (td) td.rotation.set(0, 0, -0.12);
                } else {
                    const configs = [
                        { name: 'Index', ySpread: 0.015, pZ: isPointing ? 0.00 : 0.35, iZ: isPointing ? 0.00 : 0.40, dZ: isPointing ? 0.00 : 0.25 },
                        { name: 'Middle', ySpread: 0.000, pZ: isPointing ? 0.70 : 0.40, iZ: isPointing ? 0.80 : 0.45, dZ: isPointing ? 0.50 : 0.28 },
                        { name: 'Ring', ySpread: -0.015, pZ: isPointing ? 0.75 : 0.44, iZ: isPointing ? 0.85 : 0.50, dZ: isPointing ? 0.55 : 0.30 },
                        { name: 'Little', ySpread: -0.030, pZ: isPointing ? 0.80 : 0.48, iZ: isPointing ? 0.90 : 0.55, dZ: isPointing ? 0.60 : 0.32 }
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
                    if (tp) tp.rotation.set(-0.15, 0.12, isPointing ? 0.25 : 0.20);
                    if (ti) ti.rotation.set(0, 0, isPointing ? 0.18 : 0.16);
                    if (td) td.rotation.set(0, 0, isPointing ? 0.14 : 0.12);
                }
            }
        }

        const visemeMap = { 'B': 'i', 'C': 'e', 'D': 'a', 'E': 'u', 'F': 'o', 'G': 'i', 'H': 'a' };

        window.updateFrame = function(t, phoneme, expr, tone, camMode, camAge, activeOverlay, overlayPos, activeGesture, gestAge, ltTitle, ltAge) {
            if (!vrm) return;
            const isSpeaking = phoneme && phoneme !== 'X';
            const isVRM0 = window.__isVRM0;
            const persona = isVRM0 ? PERSONA_VRM0 : PERSONA_VRM1;
            const lerp = (a, b, alpha) => a + (b - a) * alpha;

            // CR-013 Demeanor Kinematics Modifiers (Declared at top to prevent TDZ error)
            let toneHipsZ = 0.0, toneSpineX = 0.0, toneChestX = 0.0, toneHeadPitch = 0.0, joyBaseline = persona.baselineJoy;
            if (tone === 'friendly') {
                joyBaseline = 0.30;
                toneHeadPitch = Math.sin(t * 2.8) * 0.012;
            } else if (tone === 'formal') {
                toneSpineX = -0.012;
                toneHipsZ = -persona.hipTiltBase * 0.5;
            } else if (tone === 'informal') {
                toneHipsZ = 0.030;
            } else if (tone === 'authoritative') {
                toneChestX = 0.022;
                toneHeadPitch = isSpeaking ? (Math.sin(t * 3.5) * -0.018) : 0;
            }

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

            const cam = window.__camera;
            if (cam) {
                const mode = (camMode || '').toLowerCase().trim();
                const yOffset = avatarHeightDelta * 0.85;
                let basePos = POS_FULL, baseLook = LOOK_FULL, isSlow = false;
                if (mode.includes('close') || mode.includes('tight') || mode.includes('face') || mode.includes('chest')) {
                    basePos = POS_CLOSE; baseLook = LOOK_CLOSE;
                } else if (mode.includes('slowzoom') || mode.includes('slow zoom')) {
                    isSlow = true;
                    const prog = Math.min(1.0, Math.max(0.0, (camAge || 0) / 2.5));
                    const ease = 0.5 - 0.5 * Math.cos(prog * Math.PI);
                    basePos = new THREE.Vector3().lerpVectors(POS_FULL, POS_MID, ease);
                    baseLook = new THREE.Vector3().lerpVectors(LOOK_FULL, LOOK_MID, ease);
                } else if (mode.includes('mid') || mode.includes('medium')) {
                    basePos = POS_MID; baseLook = LOOK_MID;
                }
                const targetPos = new THREE.Vector3(basePos.x, basePos.y + yOffset, basePos.z);
                const targetLook = new THREE.Vector3(baseLook.x, baseLook.y + yOffset, baseLook.z);
                if (window.__lastMode !== mode) {
                    window.__lastMode = mode;
                    if (!isSlow) { cam.position.copy(targetPos); window.__camLook.copy(targetLook); }
                }
                if (isSlow) { cam.position.copy(targetPos); window.__camLook.copy(targetLook); }
                else { cam.position.lerp(targetPos, 0.35); window.__camLook.lerp(targetLook, 0.35); }
                cam.lookAt(window.__camLook);
            }

            const breathCycle = Math.sin(t * persona.breathFreq);
            const organicSway = (time, f1, f2) => Math.sin(time * f1) * 0.65 + Math.sin(time * f2) * 0.35;
            const weightShift = Math.sin(t * (2 * Math.PI / persona.weightShiftPeriod));

            if (hips) {
                hips.position.x = 0.012 + weightShift * persona.hipSwayAmp;
                hips.rotation.z = persona.hipTiltBase + weightShift * persona.hipTiltAmp + toneHipsZ;
                hips.rotation.y = 0.025 + organicSway(t, 0.30, 0.70) * 0.004;
            }
            if (spine) {
                spine.rotation.x = breathCycle * 0.008 + toneSpineX;
                spine.rotation.z = persona.spineTilt - (weightShift * 0.008);
                spine.rotation.y = -0.015;
            }
            if (chest) {
                chest.rotation.x = 0.015 + breathCycle * persona.breathAmp + toneChestX;
                chest.rotation.y = -0.012;
                chest.rotation.z = -0.006;
            }

            if (lUpLeg) lUpLeg.rotation.set(-0.02, 0.0, -0.02);
            if (lLowLeg) lLowLeg.rotation.set(0.02, 0.0, 0.0);
            if (lFoot) lFoot.rotation.set(0.0, 0.0, 0.02);
            if (rUpLeg) rUpLeg.rotation.set(0.05, 0.03, 0.04);
            if (rLowLeg) rLowLeg.rotation.set(-0.08, 0.0, 0.0);
            if (rFoot) rFoot.rotation.set(0.03, 0.0, -0.03);

            if (isVRM0) {
                if (rShoulder) rShoulder.rotation.set(0.02, 0.04, 0.03 + breathCycle * 0.006);
                if (lShoulder) lShoulder.rotation.set(-0.02, -0.02, -0.04 - breathCycle * 0.006);
            } else {
                if (rShoulder) rShoulder.rotation.set(0.015, 0.03, -0.025 - breathCycle * 0.004);
                if (lShoulder) lShoulder.rotation.set(-0.015, -0.02, 0.025 + breathCycle * 0.004);
            }

            const targetSpeechPitch = isSpeaking ? (Math.sin(t * 2.4) * 0.016 + Math.sin(t * 1.2) * 0.010) : (Math.sin(t * 0.9) * 0.004);
            const targetSpeechYaw = isSpeaking ? (Math.sin(t * 1.6) * 0.012) : 0;
            smoothedSpeechPitch = lerp(smoothedSpeechPitch, targetSpeechPitch, 0.12);
            smoothedSpeechYaw = lerp(smoothedSpeechYaw, targetSpeechYaw, 0.08);

            const headRoll = persona.headRollBias + organicSway(t, 0.40, 0.85) * persona.headRollAmp;
            const headYaw = -0.025 + smoothedSpeechYaw + organicSway(t, 0.35, 0.70) * 0.009;
            const headPitch = persona.headPitchBias + smoothedSpeechPitch + toneHeadPitch;
            if (head) head.rotation.set(headPitch, headYaw, headRoll);
            if (neck) neck.rotation.set(headPitch * 0.35, headYaw * 0.30, headRoll * 0.30);

            if (t > nextSaccadeTime) {
                nextSaccadeTime = t + persona.saccadeIntervalMin + Math.random() * persona.saccadeIntervalVar;
                saccadeTargetX = (Math.random() - 0.5) * (isVRM0 ? 0.024 : 0.016);
                saccadeTargetY = (Math.random() - 0.5) * (isVRM0 ? 0.016 : 0.010);
            }
            saccadeCurrX = lerp(saccadeCurrX, saccadeTargetX, 0.08);
            saccadeCurrY = lerp(saccadeCurrY, saccadeTargetY, 0.08);
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

            if (isVRM0) {
                if (rArm && rElbow) {
                    rArm.rotation.set(lerp(-0.16 + breathCycle * 0.005, 0.32, pw), lerp(-0.20, 0.38, pw), lerp(-1.24, 0.28, pw));
                    rElbow.rotation.set(lerp(-0.92, -0.10, pw), lerp(0.35, 0.0, pw), lerp(-0.18, 0.0, pw));
                    if (rHand) rHand.rotation.set(lerp(0.12, 0.0, pw), lerp(0.16, 0.0, pw), lerp(-0.24, 0.0, pw));
                }
                if (lArm) lArm.rotation.set(-0.16 + breathCycle * 0.005, 0.20, 1.24);
                if (lElbow) lElbow.rotation.set(-0.92, -0.35, 0.18);
                if (lHand) lHand.rotation.set(0.12, -0.16, 0.24);
            } else {
                if (rArm && rElbow) {
                    rArm.rotation.set(lerp(0.16, -0.30, pw), lerp(-0.15, -0.25, pw), lerp(1.25, 0.45, pw));
                    rElbow.rotation.set(lerp(-0.65, -0.10, pw), lerp(0.30, 0.0, pw), lerp(0.40, 0.0, pw));
                    if (rHand) rHand.rotation.set(lerp(0.10, 0.0, pw), lerp(0.12, 0.0, pw), lerp(0.18, 0.0, pw));
                }
                if (lArm) lArm.rotation.set(0.16, 0.15, -1.25);
                if (lElbow) lElbow.rotation.set(-0.65, -0.30, -0.40);
                if (lHand) lHand.rotation.set(0.10, -0.12, -0.18);
            }

            poseFingersCorrect(true, false);
            poseFingersCorrect(false, pw > 0.08);

            if (isGestActive && gest.includes('nod') && head) head.rotation.x += Math.sin(gestAge * 8.0) * 0.08;
            else if (isGestActive && (gest.includes('head shake') || gest.includes('shake')) && head) head.rotation.y += Math.sin(gestAge * 7.0) * 0.12;

            const blinkMod = t % persona.blinkPeriod;
            let blinkVal = 0;
            if (blinkMod < 0.07) blinkVal = Math.sin((blinkMod / 0.07) * (Math.PI / 2));
            else if (blinkMod < 0.22) blinkVal = Math.cos(((blinkMod - 0.07) / 0.15) * (Math.PI / 2));
            if (vrm.blendShapeProxy) vrm.blendShapeProxy.setValue('blink', blinkVal);

            const targetVowel = visemeMap[phoneme] || null;
            if (targetVowel !== activeViseme) {
                if (activeViseme && vrm.blendShapeProxy) vrm.blendShapeProxy.setValue(activeViseme, 0);
                if (targetVowel && vrm.blendShapeProxy) vrm.blendShapeProxy.setValue(targetVowel, 0.85);
                activeViseme = targetVowel;
            }

            const lower = (expr || 'neutral').toLowerCase();
            let newKey = 'neutral';
            if (lower.includes('joy') || lower.includes('smile')) newKey = 'joy';
            else if (lower.includes('excited')) newKey = 'excited';
            else if (lower.includes('serious') || lower.includes('angry')) newKey = 'angry';
            else if (lower.includes('smug')) newKey = 'smug';
            else if (lower.includes('surprised')) newKey = 'surprised';

            if (newKey !== activeEmotionKey && vrm.blendShapeProxy) {
                ['joy', 'angry', 'sorrow', 'fun'].forEach(e => vrm.blendShapeProxy.setValue(e, 0));
                if (newKey === 'joy') { vrm.blendShapeProxy.setValue('joy', 0.35); vrm.blendShapeProxy.setValue('fun', 0.25); }
                else if (newKey === 'excited') { vrm.blendShapeProxy.setValue('joy', 0.40); vrm.blendShapeProxy.setValue('fun', 0.40); }
                else if (newKey === 'angry') vrm.blendShapeProxy.setValue('angry', 0.65);
                else if (newKey === 'smug') { vrm.blendShapeProxy.setValue('fun', 0.45); vrm.blendShapeProxy.setValue('joy', 0.15); }
                else if (newKey === 'surprised') vrm.blendShapeProxy.setValue('fun', 0.60);
                activeEmotionKey = newKey;
            }

            if (activeEmotionKey === 'neutral' && vrm.blendShapeProxy) {
                vrm.blendShapeProxy.setValue('joy', joyBaseline);
                vrm.blendShapeProxy.setValue('fun', persona.baselineFun);
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
                        overlayMesh.position.set(70 + (targetW / 2), (1080 - 70) - (targetH / 2), 1);
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
            if (overlayMat.opacity > 0.005 || ltMat.opacity > 0.005) {
                renderer.clearDepth();
                renderer.render(hudScene, hudCamera);
            }

            return window.__canvas.toDataURL('image/jpeg', 0.80);
        };

        window.renderFrameBatch = function(configs) {
            const results = [];
            for (let i = 0; i < configs.length; i++) {
                const c = configs[i];
                results.push(window.updateFrame(
                    c.t, c.phoneme, c.expr, c.tone, c.cam, c.camAge,
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

let currentLoadedAvatar = 'shubo';
let globalBrowser = null;
let globalPage = null;
let staticServer = null;
let staticServerPort = 0;

const resolveModelPath = (chosen) => {
    const candidates = [
        path.join(__dirname, 'public', `${chosen}.vrm`),
        path.join(__dirname, 'public', 'Shubo.vrm'),
        path.join(__dirname, `${chosen}.vrm`),
        path.join(__dirname, 'public', 'avatar.vrm'),
        path.join(__dirname, 'avatar.vrm')
    ];
    return candidates.find(p => fs.existsSync(p)) || candidates[0];
};

const ensureStaticServer = async () => {
    if (staticServer) return staticServerPort;
    staticServer = http.createServer((req, res) => {
        const parsedUrl = req.url.split('?')[0];
        if (parsedUrl === '/' || parsedUrl === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            res.end(createHtmlContent(resolveModelPath(currentLoadedAvatar)));
            return;
        }
        if (parsedUrl === '/avatar.vrm') {
            const mPath = resolveModelPath(currentLoadedAvatar);
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(mPath).size, 'Access-Control-Allow-Origin': '*' });
            fs.createReadStream(mPath).pipe(res);
            return;
        }
        if (parsedUrl.startsWith('/node_modules/')) {
            const relPath = decodeURIComponent(parsedUrl.replace('/node_modules/', ''));
            const filePath = path.join(__dirname, 'node_modules', relPath);
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                res.writeHead(200, { 'Content-Type': path.extname(filePath) === '.json' ? 'application/json' : 'application/javascript', 'Access-Control-Allow-Origin': '*' });
                fs.createReadStream(filePath).pipe(res);
                return;
            }
        }
        res.writeHead(404); res.end();
    });
    await new Promise(r => staticServer.listen(0, '127.0.0.1', r));
    staticServerPort = staticServer.address().port;
    return staticServerPort;
};

const ensureWarmBrowser = async () => {
    if (globalBrowser && globalPage) return { browser: globalBrowser, page: globalPage };
    const port = await ensureStaticServer();
    globalBrowser = await puppeteer.launch({
        headless: true,
        args: [
            '--enable-gpu', '--use-gl=angle', '--use-angle=d3d11',
            '--enable-gpu-rasterization', '--enable-zero-copy',
            '--disable-gpu-vsync', '--disable-frame-rate-limit',
            '--ignore-gpu-blocklist', '--disable-web-security',
            '--disable-background-timer-throttling', '--disable-renderer-backgrounding'
        ]
    });
    globalPage = await globalBrowser.newPage();
    globalPage.setDefaultNavigationTimeout(120000);
    globalPage.setDefaultTimeout(120000);
    await globalPage.setViewport({ width: 1280, height: 720 });
    await globalPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await globalPage.waitForFunction('window.__ready === true', { timeout: 120000 });
    return { browser: globalBrowser, page: globalPage };
};

const executeRenderJob = async (sessionDir, timelinePath, phonemesPath, audioPath, outputPath, avatarChoiceArg, progressCb) => {
    const chosenAvatar = (avatarChoiceArg || 'shubo').toLowerCase().trim();
    const { page } = await ensureWarmBrowser();

    if (currentLoadedAvatar !== chosenAvatar) {
        currentLoadedAvatar = chosenAvatar;
        await page.evaluate(async (url) => { await window.loadAvatarModel(url); }, '/avatar.vrm');
    }

    const overlayMap = {};
    readDirToMap(path.join(sessionDir, 'overlays'), overlayMap);
    readDirToMap(sessionDir, overlayMap);
    await page.evaluate((map) => window.loadOverlays(map), overlayMap);

    const timeline = readJsonClean(timelinePath);
    let phonemes = { metadata: { duration: 5.0 }, mouthCues: [] };
    if (fs.existsSync(phonemesPath) && fs.statSync(phonemesPath).size > 0) {
        try { phonemes = readJsonClean(phonemesPath); } catch (_) {}
    }

    const ffmpeg = spawn('ffmpeg', [
        '-y',
        '-thread_queue_size', '2048',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-r', '30',
        '-i', '-',
        '-i', audioPath,
        '-vf', 'scale=1920:1080:flags=lanczos',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-threads', '4',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        outputPath
    ]);

    let ffmpegErr = '';
    ffmpeg.stderr.on('data', c => { ffmpegErr += c.toString(); if (ffmpegErr.length > 4000) ffmpegErr = ffmpegErr.slice(-2000); });
    ffmpeg.stdout.resume();

    const totalSeconds = phonemes.metadata?.duration || 10.0;
    const totalFrames = Math.max(30, Math.floor(totalSeconds * 30));

    for (let f = 0; f < totalFrames; f += BATCH_SIZE) {
        const batchCount = Math.min(BATCH_SIZE, totalFrames - f);
        const configs = [];
        for (let b = 0; b < batchCount; b++) {
            const currentFrame = f + b;
            const currentTime = currentFrame / 30;

            const activeCue = (phonemes.mouthCues || []).find(c => currentTime >= c.start && currentTime <= c.end);
            const phoneme = activeCue ? activeCue.value : 'X';
            const activeTone = timeline.filter(e => e.type === 'tone' && e.time <= currentTime).pop()?.value || 'neutral';
            const activeExpr = timeline.filter(e => e.type === 'emotion' && e.time <= currentTime).pop()?.value || 'neutral';
            const lastCamEv = timeline.filter(e => e.type === 'cam' && e.time <= (currentTime + 0.005)).pop();
            const activeCam = lastCamEv ? lastCamEv.value : 'default';
            const camAge = lastCamEv ? Math.max(0, currentTime - lastCamEv.time) : 0;
            const lastGestEv = timeline.filter(e => e.type === 'gesture' && e.time <= currentTime).pop();
            const activeGesture = lastGestEv?.value || '';
            const gestAge = lastGestEv ? (currentTime - lastGestEv.time) : 999;

            let activeOverlay = null, overlayPos = 'top-left';
            for (const ev of timeline) {
                if (ev.time <= currentTime) {
                    if (ev.type === 'show') { activeOverlay = ev.value; overlayPos = ev.position || 'top-left'; }
                    else if (ev.type === 'hide') { activeOverlay = null; }
                }
            }
            const lastLtEv = timeline.filter(e => e.type === 'lowerthird' && e.time <= currentTime).pop();
            const ltTitle = lastLtEv?.value || null;
            const ltAge = lastLtEv ? (currentTime - lastLtEv.time) : 999;

            configs.push({ t: currentTime, tone: activeTone, phoneme, expr: activeExpr, cam: activeCam, camAge, overlay: activeOverlay, overlayPos, gesture: activeGesture, gestAge, ltTitle, ltAge });
        }

        const dataUrls = await page.evaluate((batchConfigs) => window.renderFrameBatch(batchConfigs), configs);
        for (let i = 0; i < dataUrls.length; i++) {
            const d = dataUrls[i];
            if (d) {
                const b64 = d.startsWith('data:image/jpeg;base64,') ? d.slice(23) : d;
                ffmpeg.stdin.write(Buffer.from(b64, 'base64'));
            }
        }
        const currentFrameCount = Math.min(f + batchCount, totalFrames);
        if (progressCb) progressCb(currentFrameCount, totalFrames);
    }

    ffmpeg.stdin.end();
    await new Promise((resolve, reject) => {
        ffmpeg.on('close', code => {
            if (code !== 0) reject(new Error(`FFmpeg exited with code ${code}: ${ffmpegErr}`));
            else resolve();
        });
    });
};

if (isDaemonMode) {
    (async () => {
        console.log(`[Warm Daemon] Pre-warming Chromium WebGL context on port ${daemonPort}...`);
        await ensureWarmBrowser();
        console.log(`[Warm Daemon] WebGL Context and VRM model hot-ready.`);

        const daemonServer = http.createServer(async (req, res) => {
            if (req.url === '/health' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ready', avatar: currentLoadedAvatar }));
                return;
            }
            if (req.url === '/render' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', async () => {
                    try {
                        const payload = JSON.parse(body);
                        res.writeHead(200, {
                            'Content-Type': 'text/plain; charset=utf-8',
                            'Transfer-Encoding': 'chunked'
                        });
                        await executeRenderJob(
                            payload.sessionDir, payload.timelinePath, payload.phonemesPath,
                            payload.audioPath, payload.outputPath, payload.avatar,
                            (cur, total) => {
                                res.write(`PROGRESS:${cur}:${total}\n`);
                            }
                        );
                        res.write('COMPLETE\n');
                        res.end();
                    } catch (err) {
                        res.write(`ERROR:${err.message}\n`);
                        res.end();
                    }
                });
                return;
            }
            res.writeHead(404); res.end();
        });

        daemonServer.listen(daemonPort, '127.0.0.1', () => {
            console.log(`[Warm Daemon] Listening for render jobs on http://127.0.0.1:${daemonPort}`);
        });
    })();
} else {
    const [,, sessionDir, timelinePath, phonemesPath, audioPath, outputPath, avatarChoiceArg] = process.argv;
    (async () => {
        await executeRenderJob(
            sessionDir, timelinePath, phonemesPath, audioPath, outputPath, avatarChoiceArg,
            (cur, total) => {
                if (cur % 90 === 0 || cur === total) console.log(`PROGRESS:${cur}:${total}`);
            }
        );
        if (globalBrowser) await globalBrowser.close();
        if (staticServer) staticServer.close();
        console.log("Success! Video saved to: " + outputPath);
        process.exit(0);
    })();
}