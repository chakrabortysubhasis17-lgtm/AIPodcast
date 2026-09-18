import { Component, OnDestroy, ChangeDetectorRef, ElementRef, ViewChild, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

export interface RequiredSceneAsset {
  targetName: string;
  type: 'overlay' | 'background';
  file: File | null;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnDestroy, OnInit {
  @ViewChild('editorBackdrop') private editorBackdrop!: ElementRef;
  @ViewChild('logTerminal') private logTerminal!: ElementRef;

  scriptText: string = `[Cam: Mid] [Bg: stadium.jpg] [Show: logo.png]\nওয়েলকাম টু beingabong!`;
  highlightedScript: SafeHtml = '';
  requiredOverlays: RequiredSceneAsset[] = [];
  selectedAvatar: string = 'shubo';

  isRendering: boolean = false;
  renderStatus: 'idle' | 'rendering' | 'completed' | 'failed' = 'idle';
  currentStep: number = 0;
  overallProgress: number = 0;
  stepProgress: number = 0;
  statusMessage: string = '';
  elapsedSeconds: number = 0;
  etaText: string = 'Estimating...';
  videoUrl: string | null = null;
  logs: Array<{ timestamp: string; message: string }> = [];

  steps = [
    { id: 1, title: 'Voice Synthesis' },
    { id: 2, title: 'Rhubarb Visemes' },
    { id: 3, title: 'Audio Ducking' },
    { id: 4, title: '3D WebGL Composite' }
  ];

  private currentJobId: string | null = null;
  private timerInterval: any = null;
  private eventSource: EventSource | null = null;
  private stepStartTime: number = 0;

  constructor(private http: HttpClient, private sanitizer: DomSanitizer, private cdr: ChangeDetectorRef) {}

  ngOnInit() {
    this.onScriptInput();
  }

  formatDuration(totalSec: number): string {
    if (!totalSec || totalSec <= 0) return '0s';
    const sec = Math.floor(totalSec);
    if (sec < 60) return `${sec}s`;
    const mins = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (mins < 60) return `${mins}m ${remSec}s`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hours}h ${remMins}m ${remSec}s`;
  }

  updateEta() {
    // Hold calculation until the sub-step has progressed past 1% to get a clean rate sample
    if (this.stepProgress <= 1 || this.stepStartTime === 0) {
      this.etaText = 'Estimating...';
      return;
    }

    if (this.overallProgress >= 100) {
      this.etaText = '0s';
      return;
    }

    const stepElapsedSec = Math.max(0.5, (Date.now() - this.stepStartTime) / 1000);
    const timePerStepPercent = stepElapsedSec / this.stepProgress;
    const remainingStepSec = Math.max(0, (100 - this.stepProgress) * timePerStepPercent);

    this.etaText = this.formatDuration(Math.round(remainingStepSec));
  }

  onScriptInput() {
    if (this.isRendering) return;

    const escaped = this.scriptText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const highlighted = escaped.replace(/(\[[^\]]*\])/g, '<span class="tag-generic">$1</span>');
    this.highlightedScript = this.sanitizer.bypassSecurityTrustHtml(highlighted + '\n');

    const newAssets: RequiredSceneAsset[] = [];
    const showMatches = [...this.scriptText.matchAll(/\[Show:\s*["']?([^"'\]\s]+)["']?(?:\s+at\s+[a-zA-Z-]+)?\s*\]/gi)];
    const bgMatches = [...this.scriptText.matchAll(/\[Bg:\s*["']?([^"'\]\s]+)["']?\]/gi)];

    const requested = new Map<string, { filename: string; type: 'overlay' | 'background' }>();
    showMatches.forEach(m => {
      const fn = m[1].replace(/['"]/g, '').trim();
      if (fn) requested.set(fn.toLowerCase() + '::overlay', { filename: fn, type: 'overlay' });
    });
    bgMatches.forEach(m => {
      const fn = m[1].replace(/['"]/g, '').trim();
      if (fn) requested.set(fn.toLowerCase() + '::background', { filename: fn, type: 'background' });
    });

    requested.forEach(item => {
      const existing = this.requiredOverlays.find(a => a.targetName.toLowerCase() === item.filename.toLowerCase() && a.type === item.type);
      if (existing) {
        newAssets.push(existing);
      } else {
        newAssets.push({ targetName: item.filename, type: item.type, file: null });
      }
    });

    this.requiredOverlays = newAssets;
  }

  syncEditorScroll(event: Event) {
    const target = event.target as HTMLElement;
    if (this.editorBackdrop) this.editorBackdrop.nativeElement.scrollTop = target.scrollTop;
  }

  onSingleFileSelected(event: Event, index: number) {
    if (this.isRendering) return;
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.requiredOverlays[index].file = input.files[0];
    }
  }

  areAllOverlaysAttached(): boolean {
    return this.requiredOverlays.every(a => a.file !== null);
  }

  getStepTitle(id: number): string {
    return this.steps.find(s => s.id === id)?.title || 'Active Stage';
  }

  generatePodcast() {
    if (!this.areAllOverlaysAttached() || this.isRendering) return;

    this.isRendering = true;
    this.renderStatus = 'rendering';
    this.currentStep = 1;
    this.overallProgress = 0;
    this.stepProgress = 0;
    this.logs = [];
    this.videoUrl = null;
    this.elapsedSeconds = 0;
    this.stepStartTime = Date.now();
    this.etaText = 'Estimating...';

    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      this.elapsedSeconds++;
      this.updateEta();
      this.cdr.detectChanges();
    }, 1000);

    const payload = new FormData();
    payload.append('script', this.scriptText);
    payload.append('avatar', this.selectedAvatar);

    this.requiredOverlays.forEach(asset => {
      if (asset.file) {
        payload.append('files', asset.file, asset.targetName);
        payload.append(asset.targetName, asset.file, asset.targetName);
      }
    });

    this.http.post<{ jobId: string }>('http://localhost:5000/api/video/start-job', payload)
      .subscribe({
        next: (res) => {
          this.currentJobId = res.jobId;
          this.listenToJobStream(res.jobId);
        },
        error: (err) => {
          this.statusMessage = err.error?.message || 'Failed to submit render job.';
          this.renderStatus = 'failed';
          this.finishProcess();
        }
      });
  }

  cancelRender() {
    if (this.currentJobId) {
      this.http.post(`http://localhost:5000/api/video/cancel/${this.currentJobId}`, {}).subscribe();
    }
    this.statusMessage = 'Render canceled by user.';
    this.renderStatus = 'failed';
    this.finishProcess();
  }

  private listenToJobStream(jobId: string) {
    if (this.eventSource) this.eventSource.close();
    this.eventSource = new EventSource(`http://localhost:5000/api/video/stream/${jobId}`);

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.error) {
          this.statusMessage = data.error;
          this.renderStatus = 'failed';
          this.finishProcess();
          return;
        }

        const stepVal = data.step ?? data.stage;
        if (stepVal !== undefined && stepVal > 0) {
          if (this.currentStep !== stepVal) {
            this.currentStep = stepVal;
            this.stepStartTime = Date.now();
            this.stepProgress = 0;
            this.etaText = 'Estimating...';
          }
        }

        const stepProgVal = data.stepProgress ?? data.stepprogress;
        if (stepProgVal !== undefined && stepProgVal >= 0) {
          this.stepProgress = stepProgVal;
          this.updateEta();
        }

        const overallVal = data.overallProgress ?? data.percent ?? data.overallprogress;
        if (overallVal !== undefined && overallVal >= 0) {
          this.overallProgress = overallVal;
        }

        const logMsg = data.message ?? data.log ?? data.stageMessage;
        if (logMsg) {
          const now = new Date();
          const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
          this.logs.push({ timestamp: timeStr, message: logMsg });
          setTimeout(() => {
            if (this.logTerminal) {
              this.logTerminal.nativeElement.scrollTop = this.logTerminal.nativeElement.scrollHeight;
            }
          }, 10);
        }

        const isFinished = data.status === 'completed' || (logMsg && logMsg.includes('Render Complete'));

        if (data.downloadUrl) {
          this.videoUrl = `http://localhost:5000${data.downloadUrl}?t=${Date.now()}`;
          this.renderStatus = 'completed';
          this.finishProcess();
        } else if (isFinished) {
          const activeId = this.currentJobId || data.jobId || jobId;
          setTimeout(() => {
            this.videoUrl = `http://localhost:5000/api/video/download/${activeId}?t=${Date.now()}`;
            this.renderStatus = 'completed';
            this.finishProcess();
            this.cdr.detectChanges();
          }, 400);
        } else if (data.status === 'error') {
          this.statusMessage = data.message || 'Rendering failed.';
          this.renderStatus = 'failed';
          this.finishProcess();
        }

        this.cdr.detectChanges();
      } catch (err) {
        console.error('SSE JSON parse error:', err);
      }
    };

    this.eventSource.onerror = () => {
      if (this.isRendering && !this.videoUrl && this.renderStatus !== 'completed') {
        this.statusMessage = 'Connection closed or lost with server.';
        this.renderStatus = 'failed';
        this.finishProcess();
      }
    };
  }

  copyLogs() {
    const raw = this.logs.map(l => `[${l.timestamp}] ${l.message}`).join('\n');
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
    this.isRendering = false;
    this.cdr.detectChanges();
  }

  ngOnDestroy() {
    this.finishProcess();
  }
}