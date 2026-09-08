export interface RequiredAsset {
  filename: string;
  isAttached: boolean;
  selectedFile?: File;
  previewUrl?: string;
  errorMessage?: string;
}

export class AssetInspectorManager {
  public requiredAssets: RequiredAsset[] = [];
  public isGenerateLocked: boolean = false;

  public inspectScript(scriptContent: string): void {
    if (!scriptContent) {
      this.requiredAssets = [];
      this.refreshLockStatus();
      return;
    }

    const showRegex = /\[Show:\s*"([^"]+)"(?:\s*at\s*[a-zA-Z]+)?\]/gi;
    const filenames = new Set<string>();
    let match: RegExpExecArray | null;

    while ((match = showRegex.exec(scriptContent)) !== null) {
      if (match[1]) {
        filenames.add(match[1].trim());
      }
    }

    const updatedList: RequiredAsset[] = [];
    filenames.forEach(name => {
      const existing = this.requiredAssets.find(a => a.filename.toLowerCase() === name.toLowerCase());
      if (existing) {
        updatedList.push(existing);
      } else {
        updatedList.push({ filename: name, isAttached: false });
      }
    });

    this.requiredAssets = updatedList;
    this.refreshLockStatus();
  }

  public onFileSelected(targetAsset: RequiredAsset, event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];

    if (file.name.toLowerCase() !== targetAsset.filename.toLowerCase()) {
      targetAsset.isAttached = false;
      targetAsset.selectedFile = undefined;
      targetAsset.previewUrl = undefined;
      targetAsset.errorMessage = `Mismatch: Selected "${file.name}", expected "${targetAsset.filename}"`;
      input.value = '';
    } else {
      targetAsset.isAttached = true;
      targetAsset.selectedFile = file;
      targetAsset.errorMessage = undefined;
      targetAsset.previewUrl = URL.createObjectURL(file);
    }

    this.refreshLockStatus();
  }

  public refreshLockStatus(): void {
    this.isGenerateLocked = this.requiredAssets.some(a => !a.isAttached);
  }

  public appendToFormData(formData: FormData): void {
    this.requiredAssets.forEach(asset => {
      if (asset.selectedFile) {
        formData.append("overlays", asset.selectedFile, asset.filename);
      }
    });
  }
}
