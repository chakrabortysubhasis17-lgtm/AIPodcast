import { Component, OnDestroy, ChangeDetectorRef, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { AssetInspectorManager } from './components/asset-inspector';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div style="max-width: 960px; margin: 30px auto; padding: 32px; background: #1e293b; border-radius: 14px; box-shadow: 0 12px 30px rgba(0,0,0,0.4); color: #f8fafc; font-family: system-ui, -apple-system, sans-serif;">

      <div style="margin-bottom: 20px;">
        <h1 style="font-size: 26px; margin: 0; color: #38bdf8; letter-spacing: -0.5px;">🎙️ AI Podcast Video Studio</h1>
        <p style="color: #94a3b8; font-size: 14px; margin: 6px 0 0 0;">
          Bengali & English speech rendering with 3D avatar lip-sync, auto-ducking & directives.
        </p>
      </div>

      <label style="display: block; font-weight: 600; margin-bottom: 8px; color: #cbd5e1; font-size: 14px;">Podcast Script & Directives:</label>

      <!-- Syntax Highlighting Overlay Container -->
      <div style="position: relative; width: 100%; height: 210px; border-radius: 8px; overflow: hidden; border: 1px solid #334155; background: #0f172a;">

        <!-- Backdrop Mirror for Syntax Highlighting -->
        <div #backdrop style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; padding: 14px; font-family: Consolas, monospace; font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; pointer-events: none; color: #f1f5f9; overflow-y: auto; box-sizing: border-box;"
             [innerHTML]="highlightedContent">
        </div>

        <!-- Foreground Editable Textarea -->
        <textarea
          [(ngModel)]="scriptText"
          (ngModelChange)="updateHighlight()"
          (scroll)="syncScroll($event)"
          [readOnly]="isLoading"
          [style.cursor]="isLoading ? 'not-allowed' : 'text'"
          [style.opacity]="isLoading ? '0.7' : '1'"
          spellcheck="false"
          style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; padding: 14px; font-family: Consolas, monospace; font-size: 14px; line-height: 1.6; background: transparent; color: transparent; caret-color: #38bdf8; border: none; outline: none; resize: none; box-sizing: border-box; white-space: pre-wrap; word-wrap: break-word; z-index: 2;">
        </textarea>
      </div>

      <!-- Dynamic Image Upload Inspector -->
      <div *ngIf="inspector.requiredAssets.length > 0" style="margin-top: 18px; padding: 18px; background: #0f172a; border: 1px solid #334155; border-radius: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
          <span style="font-weight: 600; color: #e2e8f0; font-size: 14px;">
            Required Scene Graphics ({{ inspector.requiredAssets.length }})
          </span>
          <span style="font-size: 12px; padding: 4px 10px; border-radius: 4px; font-weight: 600;"
                [style.background]="inspector.isGenerateLocked ? 'rgba(239, 68, 68, 0.2)' : 'rgba(34, 197, 94, 0.2)'"
                [style.color]="inspector.isGenerateLocked ? '#f87171' : '#4ade80'">
            {{ inspector.isGenerateLocked ? '⚠️ Missing Attachments' : '✓ All Assets Ready' }}
          </span>
        </div>

        <div style="display: flex; flex-direction: column; gap: 10px;">
          <div *ngFor="let asset of inspector.requiredAssets"
               style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: #1e293b; border-radius: 6px; border: 1px solid;"
               [style.borderColor]="asset.errorMessage ? '#ef4444' : '#334155'">
            <div style="display: flex; align-items: center; gap: 12px;">
              <span style="font-family: Consolas, monospace; color: #38bdf8; font-size: 13px;">{{ asset.filename }}</span>
              <span *ngIf="asset.isAttached" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: #15803d; color: #bbf7d0;">✓ Attached</span>
              <span *ngIf="!asset.isAttached && !asset.errorMessage" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: #854d0e; color: #fef08a;">Required</span>
              <span *ngIf="asset.errorMessage" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: #7f1d1d; color: #fca5a5;">{{ asset.errorMessage }}</span>
            </div>

            <div style="display: flex; align-items: center; gap: 12px;">
              <input type="file" accept="image/*" (change)="inspector.onFileSelected(asset, $event)" #fileInput style="display: none;" />
              <button type="button" (click)="fileInput.click()" style="background: #0284c7; color: white; border: none; padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;">
                {{ asset.isAttached ? 'Replace' : 'Browse File' }}
              </button>
              <img *ngIf="asset.previewUrl" [src]="asset.previewUrl" style="width: 36px; height: 36px; object-fit: cover; border-radius: 4px; border: 1px solid #475569;" alt="Preview" />
            </div>
          </div>
        </div>
      </div>

      <!-- Avatar Selection Radio Buttons -->
      <div style="margin-top: 18px; padding: 12px 16px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 15px;">👤</span>
          <span style="font-weight: 600; color: #e2e8f0; font-size: 14px;">Select 3D Avatar:</span>
        </div>
        <div style="display: flex; gap: 20px; align-items: center;">
          <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; color: #f8fafc; font-size: 14px; font-weight: 500;">
            <input type="radio" name="avatarChoice" value="mina" [(ngModel)]="selectedAvatar" style="accent-color: #38bdf8; cursor: pointer;">
            Mina <span style="font-size: 11px; color: #38bdf8; background: rgba(56, 189, 248, 0.15); padding: 1px 6px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.3);">Default</span>
          </label>
          <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; color: #f8fafc; font-size: 14px; font-weight: 500;">
            <input type="radio" name="avatarChoice" value="tina" [(ngModel)]="selectedAvatar" style="accent-color: #38bdf8; cursor: pointer;">
            Tina
          </label>
        </div>
      </div>

      <!-- Action & Cancel Buttons -->
      <div style="margin-top: 18px; display: flex; align-items: center; gap: 14px;">
        <button
          (click)="generateVideo()"
          [disabled]="isLoading || inspector.isGenerateLocked"
          [style.cursor]="(isLoading || inspector.isGenerateLocked) ? 'not-allowed' : 'pointer'"
          [style.background]="(isLoading || inspector.isGenerateLocked) ? '#475569' : '#0284c7'"
          style="padding: 12px 30px; font-size: 15px; font-weight: 600; color: white; border: none; border-radius: 8px; transition: all 0.2s ease;">
          {{ isLoading ? 'Rendering in progress...' : '🚀 Generate YouTube MP4' }}
        </button>

        <button
          *ngIf="isLoading"
          (click)="cancelRender()"
          style="padding: 12px 24px; font-size: 15px; font-weight: 600; color: white; background: #dc2626; border: none; border-radius: 8px; cursor: pointer; transition: background 0.2s;">
          🛑 Cancel Render
        </button>
      </div>

      <!-- Stepper & Dual Progress Dashboard -->
      <div *ngIf="isLoading || progressPercent > 0 || errorMessage" style="margin-top: 24px; padding: 22px; background: #0f172a; border: 1px solid #38bdf8; border-radius: 10px;">

        <!-- Synchronized 4-Stage Stepper -->
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px;">
          <div [style.background]="getStageBg(1)" [style.border]="getStageBorder(1)" [style.color]="getStageColor(1)" style="padding: 10px 8px; border-radius: 6px; text-align: center; font-size: 12px; font-weight: 600; transition: all 0.3s;">
            <span *ngIf="currentStage > 1">✓ </span>1. Voice Synthesis
          </div>

          <div [style.background]="getStageBg(2)" [style.border]="getStageBorder(2)" [style.color]="getStageColor(2)" style="padding: 10px 8px; border-radius: 6px; text-align: center; font-size: 12px; font-weight: 600; transition: all 0.3s;">
            <span *ngIf="currentStage > 2">✓ </span>2. Rhubarb Visemes
          </div>

          <div [style.background]="getStageBg(3)" [style.border]="getStageBorder(3)" [style.color]="getStageColor(3)" style="padding: 10px 8px; border-radius: 6px; text-align: center; font-size: 12px; font-weight: 600; transition: all 0.3s;">
            <span *ngIf="currentStage > 3">✓ </span>3. Audio Ducking
          </div>

          <div [style.background]="getStageBg(4)" [style.border]="getStageBorder(4)" [style.color]="getStageColor(4)" style="padding: 10px 8px; border-radius: 6px; text-align: center; font-size: 12px; font-weight: 600; transition: all 0.3s;">
            <span *ngIf="progressPercent === 100">✓ </span>4. 3D WebGL Composite
          </div>
        </div>

        <!-- 1. OVERALL PROGRESS BAR -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <div *ngIf="isLoading" class="spinner"></div>
            <span *ngIf="!isLoading && errorMessage" style="color: #ef4444; font-size: 18px;">⚠️</span>
            <span [style.color]="errorMessage ? '#ef4444' : '#38bdf8'" style="font-weight: 600; font-size: 14px;">
              {{ errorMessage ? 'Render Halted: ' + errorMessage : currentStepText }}
            </span>
          </div>
          <span [style.color]="errorMessage ? '#ef4444' : '#38bdf8'" style="font-size: 20px; font-weight: 700; font-family: monospace;">
            {{ progressPercent }}%
          </span>
        </div>

        <div style="width: 100%; height: 10px; background: #334155; border-radius: 5px; overflow: hidden; margin-bottom: 16px;">
          <div
            [style.width.%]="progressPercent"
            [style.background]="errorMessage ? '#dc2626' : 'linear-gradient(90deg, #0284c7, #38bdf8)'"
            style="height: 100%; border-radius: 5px; transition: width 0.2s ease-out;">
          </div>
        </div>

        <!-- 2. STEP PROGRESS BAR WITH ESTIMATED TIME LEFT -->
        <div *ngIf="isLoading && progressPercent < 100" style="background: rgba(15, 23, 42, 0.7); border: 1px solid #1e293b; border-radius: 8px; padding: 12px; margin-bottom: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 13px; font-weight: 600; color: #e2e8f0;">
                Stage {{ currentStage }}: {{ getStageTitle(currentStage) }}
              </span>
              <span *ngIf="stepEtaText" style="font-size: 11px; padding: 2px 7px; border-radius: 4px; background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3);">
                ⏳ {{ stepEtaText }}
              </span>
            </div>
            <span style="font-size: 13px; font-weight: 700; color: #34d399; font-family: monospace;">
              {{ stepProgress }}%
            </span>
          </div>

          <div style="width: 100%; height: 6px; background: #1e293b; border-radius: 3px; overflow: hidden;">
            <div
              [style.width.%]="stepProgress"
              style="height: 100%; background: linear-gradient(90deg, #06b6d4, #10b981); border-radius: 3px; transition: width 0.25s ease-out;">
            </div>
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px; font-size: 12px; color: #94a3b8;">
          <span>Pipeline: Google TTS ➔ Rhubarb Visemes ➔ D3D11 Canvas Pipe ➔ FFmpeg</span>
          <span>Elapsed: {{ elapsedSeconds }}s</span>
        </div>
      </div>

      <!-- Execution Terminal -->
      <div *ngIf="logs.length > 0" style="margin-top: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <span style="font-size: 12px; font-weight: 600; color: #94a3b8; text-transform: uppercase;">Live Execution Logs:</span>
          <button (click)="copyLogs()" style="background: transparent; border: 1px solid #475569; color: #cbd5e1; padding: 2px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;">📋 Copy Logs</button>
        </div>
        <div #logContainer style="height: 220px; overflow-y: auto; background: #030712; border: 1px solid #1e293b; border-radius: 6px; padding: 12px; font-family: Consolas, monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap;">
          <div *ngFor="let item of logs" [style.color]="item.isError ? '#fca5a5' : item.isNotice ? '#38bdf8' : '#a5f3fc'">
            <span style="color: #64748b; margin-right: 8px;">[{{ item.time }}]</span>{{ item.text }}
          </div>
        </div>
      </div>

      <!-- Result Video Player -->
      <div *ngIf="downloadUrl" style="margin-top: 36px; border-top: 1px solid #334155; padding-top: 24px;">
        <h3 style="margin: 0 0 14px 0; color: #4ade80;">✅ Video Generated Successfully</h3>
        <video [src]="downloadUrl" controls autoplay width="100%" style="border-radius: 8px; background: black; max-height: 480px;"></video>
        <div style="margin-top: 16px;">
          <a [href]="downloadUrl" download="podcast.mp4" style="display: inline-block; padding: 10px 24px; background: #16a34a; color: white; text-decoration: none; border-radius: 6px; font-weight: 600;">
            ⬇️ Download MP4
          </a>
        </div>
      </div>

    </div>
  `,
  styles: [`
    .spinner {
      width: 20px;
      height: 20px;
      border: 3px solid rgba(56, 189, 248, 0.2);
      border-top-color: #38bdf8;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      flex-shrink: 0;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  `]
})
export class AppComponent implements OnDestroy {
  @ViewChild('backdrop') private backdrop!: ElementRef;
  @ViewChild('logContainer') private logContainer!: ElementRef;

  public inspector = new AssetInspectorManager();

  selectedAvatar: string = 'mina';

  scriptText: string = `[LowerThird: "Welcome to beingabong"] [SFX: Whoosh]
[Cam: Mid] [Emotion: Joy]
Hey guys, welcome back to the podcast!
[Pause: 1.0s]
[Cam: Slow Zoom] [Emotion: Serious] [Gesture: Nod]
ফুটবল অনেকের কাছে just ৯০ মিনিটের একটা game। But কিছু ক্লাবের কাছে ফুটবল মানে বেঁচে থাকার লড়াই, আত্মসম্মান আর pure emotion।
[Pause: 1.2s]
[Cam: Close-up] [Emotion: Smug]
আজ আমরা কথা বলব ময়দানের এমন একটা ক্লাবকে নিয়ে, যার ইতিহাস কোনো Hollywood সিনেমার চেয়ে কম নয়—East Bengal FC!
[Pause: 0.8s]
[Cam: Shake] [Emotion: Surprised]
একটা চরম অপমান আর open discrimination থেকে কীভাবে এই ক্লাবের জন্ম হয়েছিল?`;

  highlightedContent: SafeHtml = '';
  isLoading: boolean = false;
  currentStage: number = 0;
  progressPercent: number = 0;
  stepProgress: number = 0;
  stepEtaText: string = '';
  currentStepText: string = '';
  elapsedSeconds: number = 0;
  logs: Array<{ text: string; time: string; isError: boolean; isNotice: boolean }> = [];
  errorMessage: string | null = null;
  downloadUrl: string | null = null;

  private stageStartTime: number = 0;
  private currentJobId: string | null = null;
  private timerInterval: any = null;
  private eventSource: EventSource | null = null;
  private isCompleted: boolean = false;

  constructor(private http: HttpClient, private sanitizer: DomSanitizer, private cdr: ChangeDetectorRef) {
    this.updateHighlight();
  }

  getStageTitle(stageNum: number): string {
    switch (stageNum) {
      case 1: return 'Voice Synthesis';
      case 2: return 'Rhubarb Visemes';
      case 3: return 'Audio Ducking';
      case 4: return '3D WebGL Composite';
      default: return 'Active Stage';
    }
  }

  updateHighlight() {
    this.inspector.inspectScript(this.scriptText);

    const escaped = this.scriptText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const highlighted = escaped.replace(/(\[[^\]]*\])/g, '<span style="color: #38bdf8; background: rgba(56, 189, 248, 0.2); border-radius: 4px; padding: 1px 4px; font-weight: bold;">$1</span>');
    this.highlightedContent = this.sanitizer.bypassSecurityTrustHtml(highlighted + '\n');
  }

  syncScroll(event: Event) {
    const target = event.target as HTMLElement;
    if (this.backdrop) {
      this.backdrop.nativeElement.scrollTop = target.scrollTop;
    }
  }

  getStageBg(stageNum: number): string {
    if (this.progressPercent === 100 || this.currentStage > stageNum) return '#15803d';
    if (this.currentStage === stageNum) return '#0284c7';
    return '#1e293b';
  }

  getStageBorder(stageNum: number): string {
    if (this.progressPercent === 100 || this.currentStage > stageNum) return '1px solid #22c55e';
    if (this.currentStage === stageNum) return '1px solid #38bdf8';
    return '1px solid #334155';
  }

  getStageColor(stageNum: number): string {
    if (this.progressPercent === 100 || this.currentStage >= stageNum) return '#ffffff';
    return '#64748b';
  }

  private calculateStepEta(progress: number) {
    if (progress <= 1) {
      this.stepEtaText = 'Estimating...';
      return;
    }
    if (progress >= 100) {
      this.stepEtaText = 'Completed';
      return;
    }

    const elapsedMs = Date.now() - this.stageStartTime;
    const estimatedTotalMs = (elapsedMs / progress) * 100;
    const remainingSec = Math.max(0, Math.round((estimatedTotalMs - elapsedMs) / 1000));
    this.stepEtaText = `~${remainingSec}s remaining`;
  }

  generateVideo() {
    if (this.inspector.isGenerateLocked) return;

    this.isLoading = true;
    this.isCompleted = false;
    this.currentStage = 1;
    this.progressPercent = 0;
    this.stepProgress = 0;
    this.stepEtaText = '';
    this.stageStartTime = Date.now();
    this.logs = [];
    this.errorMessage = null;
    this.downloadUrl = null;
    this.elapsedSeconds = 0;
    this.currentStepText = 'Submitting script payload...';

    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      this.elapsedSeconds++;
      this.cdr.detectChanges();
    }, 1000);

    const payload = new FormData();
    payload.append('script', this.scriptText);
    payload.append('avatar', this.selectedAvatar);
    this.inspector.appendToFormData(payload);

    this.http.post<{ jobId: string }>('http://localhost:5000/api/video/start-job', payload)
      .subscribe({
        next: (res) => {
          this.currentJobId = res.jobId;
          this.listenToJobStream(res.jobId);
        },
        error: (err) => {
          this.errorMessage = err.error?.message || 'Failed to submit render job.';
          this.finishProcess();
        }
      });
  }

  cancelRender() {
    if (this.currentJobId) {
      this.http.post(`http://localhost:5000/api/video/cancel/${this.currentJobId}`, {}).subscribe();
    }
    this.errorMessage = 'Render was canceled by user.';
    this.finishProcess();
  }

  private listenToJobStream(jobId: string) {
    if (this.eventSource) this.eventSource.close();

    this.eventSource = new EventSource(`http://localhost:5000/api/video/stream/${jobId}`);

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.error) {
          this.errorMessage = data.error;
          this.finishProcess();
          return;
        }

        const stepVal = data.step ?? data.stage;
        if (stepVal !== undefined && stepVal > 0) {
          if (stepVal !== this.currentStage) {
            this.currentStage = stepVal;
            this.stepProgress = 0;
            this.stageStartTime = Date.now();
            this.stepEtaText = 'Estimating...';
          }
        }

        const stepProgVal = data.stepProgress ?? data.stepprogress;
        if (stepProgVal !== undefined && stepProgVal >= 0) {
          this.stepProgress = stepProgVal;
          this.calculateStepEta(stepProgVal);
        }

        const overallVal = data.overallProgress ?? data.percent ?? data.overallprogress;
        if (overallVal !== undefined && overallVal >= 0) {
          this.progressPercent = overallVal;
        }

        const msg = data.message ?? data.stageMessage;
        if (msg) {
          this.currentStepText = msg;
        }

        const logMsg = data.message ?? data.log;
        if (logMsg) {
          const now = new Date();
          const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
          this.logs.push({
            text: logMsg,
            time: timeStr,
            isError: logMsg.includes('Error') || logMsg.includes('FATAL'),
            isNotice: logMsg.startsWith('[TTS]') || logMsg.startsWith('[Rhubarb]')
          });

          setTimeout(() => {
            if (this.logContainer) {
              this.logContainer.nativeElement.scrollTop = this.logContainer.nativeElement.scrollHeight;
            }
          }, 10);
        }

        const isFinished = data.status === 'completed' || 
                           (msg && msg.includes('Render Complete'));

        if (data.downloadUrl) {
          this.isCompleted = true;
          this.downloadUrl = `http://localhost:5000${data.downloadUrl}?t=${Date.now()}`;
          this.finishProcess();
        } else if (isFinished) {
          this.isCompleted = true;
          const activeId = this.currentJobId || data.jobId || jobId;
          setTimeout(() => {
            this.downloadUrl = `http://localhost:5000/api/video/download/${activeId}?t=${Date.now()}`;
            this.finishProcess();
            this.cdr.detectChanges();
          }, 400);
        } else if (data.status === 'error') {
          this.errorMessage = data.message || 'Rendering failed.';
          this.finishProcess();
        }

        this.cdr.detectChanges();
      } catch (err) {
        console.error('SSE JSON parse error:', err);
      }
    };

    this.eventSource.onerror = () => {
      if (this.isLoading && !this.downloadUrl && !this.isCompleted) {
        this.errorMessage = 'Connection closed or lost with server.';
        this.finishProcess();
      }
    };
  }

  copyLogs() {
    const raw = this.logs.map((l: any) => `[${l.time}] ${l.text}`).join('\n');
    navigator.clipboard.writeText(raw);
  }

  private finishProcess() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    this.isLoading = false;
    this.cdr.detectChanges();
  }

  ngOnDestroy() {
    this.finishProcess();
  }
}
