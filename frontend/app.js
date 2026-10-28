/**
 * Chaukhat 3D Gaussian Splatting Studio — Frontend Logic
 * Live Camera Recording, Interval Photo Bursts, File Dropzone, Auto-Zipping, and Pipeline Tracking.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State Management
  // ---------------------------------------------------------------------------
  const state = {
    apiBase: '',
    currentStream: null,
    mediaRecorder: null,
    recordedChunks: [],
    recordingTimer: null,
    recordingSeconds: 0,
    burstInterval: null,
    burstFrames: [],
    stagedFile: null,
    activeJobId: null,
    pollingInterval: null,
    jobStartTime: null,
    elapsedTimer: null,
    facingMode: 'environment', // Default to back camera on mobile
    availableVideoDevices: [],
  };

  // ---------------------------------------------------------------------------
  // DOM Elements
  // ---------------------------------------------------------------------------
  const dom = {
    // Header & Settings
    backendStatusBadge: document.getElementById('backend-status-badge'),
    backendStatusText: document.getElementById('backend-status-text'),
    settingsToggleBtn: document.getElementById('settings-toggle-btn'),
    settingsPanel: document.getElementById('settings-panel'),
    apiUrlInput: document.getElementById('api-url-input'),
    saveApiUrlBtn: document.getElementById('save-api-url-btn'),

    // Tabs
    tabCameraBtn: document.getElementById('tab-camera-btn'),
    tabUploadBtn: document.getElementById('tab-upload-btn'),
    cameraPane: document.getElementById('camera-pane'),
    uploadPane: document.getElementById('upload-pane'),

    // Camera
    cameraIdleView: document.getElementById('camera-idle-view'),
    cameraActiveView: document.getElementById('camera-active-view'),
    cameraVideoPreview: document.getElementById('camera-video-preview'),
    cameraFlash: document.getElementById('camera-flash'),
    startCameraBtn: document.getElementById('start-camera-btn'),
    stopCameraBtn: document.getElementById('stop-camera-btn'),
    cameraDeviceSelect: document.getElementById('camera-device-select'),
    switchFacingBtn: document.getElementById('switch-facing-btn'),
    recordingOverlay: document.getElementById('recording-overlay'),
    recModeLabel: document.getElementById('rec-mode-label'),
    recTimer: document.getElementById('rec-timer'),
    burstCountBadge: document.getElementById('burst-count-badge'),
    burstCountNum: document.getElementById('burst-count-num'),
    recordVideoToggleBtn: document.getElementById('record-video-toggle-btn'),
    recordVideoBtnText: document.getElementById('record-video-btn-text'),
    burstPhotoToggleBtn: document.getElementById('burst-photo-toggle-btn'),

    // Review Recording
    recordedPreviewContainer: document.getElementById('recorded-preview-container'),
    recordedPlaybackVideo: document.getElementById('recorded-playback-video'),
    recordedFileSize: document.getElementById('recorded-file-size'),
    recordedDuration: document.getElementById('recorded-duration'),
    acceptRecordingBtn: document.getElementById('accept-recording-btn'),
    retakeRecordingBtn: document.getElementById('retake-recording-btn'),

    // Upload & Dropzone
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('file-input'),
    browseFilesBtn: document.getElementById('browse-files-btn'),
    zippingProgress: document.getElementById('zipping-progress'),
    zippingLabel: document.getElementById('zipping-label'),
    zippingFill: document.getElementById('zipping-fill'),
    selectedFileCard: document.getElementById('selected-file-card'),
    selectedFileName: document.getElementById('selected-file-name'),
    selectedFileMeta: document.getElementById('selected-file-meta'),
    selectedFileIcon: document.getElementById('selected-file-icon'),
    removeFileBtn: document.getElementById('remove-file-btn'),

    // Tuning & Launch
    iterBtns: document.querySelectorAll('.iter-btn'),
    iterationsValue: document.getElementById('iterations-value'),
    launchPipelineBtn: document.getElementById('launch-pipeline-btn'),

    // Sections
    captureSection: document.getElementById('capture-section'),
    trackingSection: document.getElementById('tracking-section'),
    resultsSection: document.getElementById('results-section'),
    errorSection: document.getElementById('error-section'),

    // Tracking
    jobIdLabel: document.getElementById('job-id-label'),
    trackingStatusDesc: document.getElementById('tracking-status-desc'),
    elapsedTimeCounter: document.getElementById('elapsed-time-counter'),
    mainProgressBar: document.getElementById('main-progress-bar'),
    statExtractedFrames: document.getElementById('stat-extracted-frames'),
    statRegisteredPoses: document.getElementById('stat-registered-poses'),
    statIterations: document.getElementById('stat-iterations'),
    terminalLogs: document.getElementById('terminal-logs'),

    // Results
    downloadPlyBtn: document.getElementById('download-ply-btn'),
    downloadFileSize: document.getElementById('download-file-size'),
    resetWorkspaceBtn: document.getElementById('reset-workspace-btn'),

    // Error
    errorMessageText: document.getElementById('error-message-text'),
    errorRetryBtn: document.getElementById('error-retry-btn'),
  };

  // ---------------------------------------------------------------------------
  // Helper: Formatting & Logging
  // ---------------------------------------------------------------------------
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function formatTime(totalSeconds) {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  function appendLog(message, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    const timestamp = new Date().toLocaleTimeString([], { hour12: false });
    entry.textContent = `[${timestamp}] ${message}`;
    dom.terminalLogs.appendChild(entry);
    dom.terminalLogs.scrollTop = dom.terminalLogs.scrollHeight;
  }

  // ---------------------------------------------------------------------------
  // API URL & Backend Health
  // ---------------------------------------------------------------------------
  function initApiBase() {
    const saved = localStorage.getItem('chaukhat_api_url');
    if (saved) {
      state.apiBase = saved.replace(/\/+$/, '');
      dom.apiUrlInput.value = state.apiBase;
    } else {
      // If hosted on Modal directly, window.location.origin is the Modal app URL!
      if (window.location.protocol.startsWith('http') && !window.location.port.includes('3000')) {
        state.apiBase = window.location.origin;
      } else {
        state.apiBase = '';
      }
      dom.apiUrlInput.value = state.apiBase;
    }
    checkBackendHealth();
  }

  async function checkBackendHealth() {
    dom.backendStatusBadge.className = 'badge badge-neutral';
    dom.backendStatusText.textContent = 'Checking...';

    const testUrl = state.apiBase ? `${state.apiBase}/` : '/';
    try {
      const res = await fetch(testUrl, { method: 'GET' });
      if (res.ok) {
        dom.backendStatusBadge.className = 'badge badge-success';
        dom.backendStatusText.textContent = 'Modal Cloud Connected';
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      dom.backendStatusBadge.className = 'badge badge-danger';
      dom.backendStatusText.textContent = 'Backend Offline';
      console.warn('Backend ping failed:', err);
    }
  }

  dom.settingsToggleBtn.addEventListener('click', () => {
    dom.settingsPanel.classList.toggle('hidden');
  });

  dom.saveApiUrlBtn.addEventListener('click', () => {
    const val = dom.apiUrlInput.value.trim().replace(/\/+$/, '');
    state.apiBase = val;
    if (val) {
      localStorage.setItem('chaukhat_api_url', val);
    } else {
      localStorage.removeItem('chaukhat_api_url');
    }
    dom.settingsPanel.classList.add('hidden');
    checkBackendHealth();
  });

  // ---------------------------------------------------------------------------
  // Tab Navigation
  // ---------------------------------------------------------------------------
  function switchTab(target) {
    if (target === 'camera-pane') {
      dom.tabCameraBtn.classList.add('active');
      dom.tabUploadBtn.classList.remove('active');
      dom.cameraPane.classList.add('active');
      dom.uploadPane.classList.remove('active');
    } else {
      dom.tabUploadBtn.classList.add('active');
      dom.tabCameraBtn.classList.remove('active');
      dom.uploadPane.classList.add('active');
      dom.cameraPane.classList.remove('active');
      stopCamera();
    }
  }

  dom.tabCameraBtn.addEventListener('click', () => switchTab('camera-pane'));
  dom.tabUploadBtn.addEventListener('click', () => switchTab('upload-pane'));

  // ---------------------------------------------------------------------------
  // Camera Management
  // ---------------------------------------------------------------------------
  async function enumerateCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      state.availableVideoDevices = devices.filter((d) => d.kind === 'videoinput');
      dom.cameraDeviceSelect.innerHTML = '';
      if (state.availableVideoDevices.length === 0) {
        dom.cameraDeviceSelect.innerHTML = '<option value="">Default Camera</option>';
        return;
      }
      state.availableVideoDevices.forEach((dev, idx) => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        opt.textContent = dev.label || `Camera ${idx + 1}`;
        dom.cameraDeviceSelect.appendChild(opt);
      });
    } catch (e) {
      console.warn('Could not enumerate cameras:', e);
    }
  }

  async function startCamera(deviceId = null) {
    stopCamera();

    const constraints = {
      audio: false,
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    };

    if (deviceId) {
      constraints.video.deviceId = { exact: deviceId };
    } else {
      constraints.video.facingMode = { ideal: state.facingMode };
    }

    try {
      state.currentStream = await navigator.mediaDevices.getUserMedia(constraints);
      dom.cameraVideoPreview.srcObject = state.currentStream;
      dom.cameraIdleView.classList.add('hidden');
      dom.cameraActiveView.classList.remove('hidden');
      dom.recordedPreviewContainer.classList.add('hidden');
      await enumerateCameras();
    } catch (err) {
      console.error('Camera access error:', err);
      // Fallback with basic constraints
      try {
        state.currentStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        dom.cameraVideoPreview.srcObject = state.currentStream;
        dom.cameraIdleView.classList.add('hidden');
        dom.cameraActiveView.classList.remove('hidden');
      } catch (fallbackErr) {
        alert('Could not access camera. Please allow camera permissions in your browser.');
      }
    }
  }

  function stopCamera() {
    if (state.burstInterval) {
      clearInterval(state.burstInterval);
      state.burstInterval = null;
    }
    if (state.recordingTimer) {
      clearInterval(state.recordingTimer);
      state.recordingTimer = null;
    }
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      state.mediaRecorder.stop();
    }
    if (state.currentStream) {
      state.currentStream.getTracks().forEach((track) => track.stop());
      state.currentStream = null;
    }
    dom.cameraVideoPreview.srcObject = null;
    dom.cameraActiveView.classList.add('hidden');
    dom.cameraIdleView.classList.remove('hidden');
    dom.recordingOverlay.classList.add('hidden');
  }

  dom.startCameraBtn.addEventListener('click', () => startCamera());
  dom.stopCameraBtn.addEventListener('click', () => stopCamera());

  dom.cameraDeviceSelect.addEventListener('change', (e) => {
    if (e.target.value) {
      startCamera(e.target.value);
    }
  });

  dom.switchFacingBtn.addEventListener('click', () => {
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    startCamera();
  });

  // ---------------------------------------------------------------------------
  // Video Recording Mode
  // ---------------------------------------------------------------------------
  function getSupportedMimeType() {
    const types = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ];
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  function startVideoRecording() {
    if (!state.currentStream) return;
    state.recordedChunks = [];
    const mimeType = getSupportedMimeType();

    try {
      state.mediaRecorder = mimeType
        ? new MediaRecorder(state.currentStream, { mimeType })
        : new MediaRecorder(state.currentStream);
    } catch (e) {
      state.mediaRecorder = new MediaRecorder(state.currentStream);
    }

    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        state.recordedChunks.push(e.data);
      }
    };

    state.mediaRecorder.onstop = () => {
      const mime = state.mediaRecorder.mimeType || 'video/webm';
      const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      const videoBlob = new Blob(state.recordedChunks, { type: mime });
      const videoUrl = URL.createObjectURL(videoBlob);

      dom.recordedPlaybackVideo.src = videoUrl;
      dom.recordedFileSize.textContent = `Size: ${formatBytes(videoBlob.size)}`;
      dom.recordedDuration.textContent = `Duration: ${state.recordingSeconds}s`;

      dom.cameraActiveView.classList.add('hidden');
      dom.recordedPreviewContainer.classList.remove('hidden');

      // Stash blob for acceptance
      state.pendingRecordedBlob = videoBlob;
      state.pendingRecordedName = `room_scan_${Date.now()}.${ext}`;
    };

    state.mediaRecorder.start(500); // 500ms chunk interval
    state.recordingSeconds = 0;
    dom.recModeLabel.textContent = 'REC';
    dom.recTimer.textContent = '00:00';
    dom.recordingOverlay.classList.remove('hidden');
    dom.burstCountBadge.classList.add('hidden');

    dom.recordVideoToggleBtn.classList.remove('btn-danger');
    dom.recordVideoToggleBtn.classList.add('btn-secondary');
    dom.recordVideoBtnText.textContent = 'Stop Recording';
    dom.burstPhotoToggleBtn.disabled = true;

    state.recordingTimer = setInterval(() => {
      state.recordingSeconds++;
      dom.recTimer.textContent = formatTime(state.recordingSeconds);
      if (state.recordingSeconds >= 120) {
        // Safe cap at 2 minutes
        stopVideoRecording();
      }
    }, 1000);
  }

  function stopVideoRecording() {
    if (state.recordingTimer) {
      clearInterval(state.recordingTimer);
      state.recordingTimer = null;
    }
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      state.mediaRecorder.stop();
    }
    dom.recordingOverlay.classList.add('hidden');
    dom.recordVideoToggleBtn.classList.remove('btn-secondary');
    dom.recordVideoToggleBtn.classList.add('btn-danger');
    dom.recordVideoBtnText.textContent = 'Record Video Clip';
    dom.burstPhotoToggleBtn.disabled = false;
  }

  dom.recordVideoToggleBtn.addEventListener('click', () => {
    if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
      stopVideoRecording();
    } else {
      startVideoRecording();
    }
  });

  dom.acceptRecordingBtn.addEventListener('click', () => {
    if (state.pendingRecordedBlob) {
      setStagedFile(
        new File([state.pendingRecordedBlob], state.pendingRecordedName, {
          type: state.pendingRecordedBlob.type,
        })
      );
      dom.recordedPreviewContainer.classList.add('hidden');
      stopCamera();
      // Scroll to launch button
      dom.launchPipelineBtn.scrollIntoView({ behavior: 'smooth' });
    }
  });

  dom.retakeRecordingBtn.addEventListener('click', () => {
    dom.recordedPreviewContainer.classList.add('hidden');
    dom.cameraActiveView.classList.remove('hidden');
  });

  // ---------------------------------------------------------------------------
  // Burst Photo Sequence Mode (Walkthrough scanner)
  // ---------------------------------------------------------------------------
  function triggerShutterFlash() {
    dom.cameraFlash.classList.add('flash-active');
    setTimeout(() => {
      dom.cameraFlash.classList.remove('flash-active');
    }, 120);
  }

  function captureFrameToBlob() {
    const video = dom.cameraVideoPreview;
    if (!video.videoWidth || !video.videoHeight) return null;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.92);
    });
  }

  async function startBurstMode() {
    state.burstFrames = [];
    dom.recModeLabel.textContent = 'BURST SCAN';
    dom.recTimer.textContent = '00:00';
    dom.burstCountNum.textContent = '0';
    dom.recordingOverlay.classList.remove('hidden');
    dom.burstCountBadge.classList.remove('hidden');

    dom.burstPhotoToggleBtn.classList.add('btn-danger');
    dom.burstPhotoToggleBtn.textContent = '⏹️ Stop & Package Burst';
    dom.recordVideoToggleBtn.disabled = true;

    state.recordingSeconds = 0;
    state.recordingTimer = setInterval(() => {
      state.recordingSeconds++;
      dom.recTimer.textContent = formatTime(state.recordingSeconds);
    }, 1000);

    // Capture first frame immediately
    const firstBlob = await captureFrameToBlob();
    if (firstBlob) {
      state.burstFrames.push(firstBlob);
      dom.burstCountNum.textContent = state.burstFrames.length;
      triggerShutterFlash();
    }

    // Interval snapshot every 1.4 seconds
    state.burstInterval = setInterval(async () => {
      const blob = await captureFrameToBlob();
      if (blob) {
        state.burstFrames.push(blob);
        dom.burstCountNum.textContent = state.burstFrames.length;
        triggerShutterFlash();
      }
      if (state.burstFrames.length >= 80) {
        stopBurstMode();
      }
    }, 1400);
  }

  async function stopBurstMode() {
    if (state.burstInterval) {
      clearInterval(state.burstInterval);
      state.burstInterval = null;
    }
    if (state.recordingTimer) {
      clearInterval(state.recordingTimer);
      state.recordingTimer = null;
    }
    dom.recordingOverlay.classList.add('hidden');
    dom.burstPhotoToggleBtn.classList.remove('btn-danger');
    dom.burstPhotoToggleBtn.textContent = '⏱️ Auto Burst Scan';
    dom.recordVideoToggleBtn.disabled = false;

    if (state.burstFrames.length < 5) {
      alert(`Only captured ${state.burstFrames.length} photos. Please capture at least 10–20 photos for 3D reconstruction.`);
      return;
    }

    // Bundle into .zip via JSZip
    await packageBlobsIntoZip(state.burstFrames, `burst_scan_${Date.now()}.zip`);
    stopCamera();
  }

  dom.burstPhotoToggleBtn.addEventListener('click', () => {
    if (state.burstInterval) {
      stopBurstMode();
    } else {
      startBurstMode();
    }
  });

  // ---------------------------------------------------------------------------
  // Zip Generation with JSZip
  // ---------------------------------------------------------------------------
  async function packageBlobsIntoZip(blobs, zipFilename) {
    if (typeof JSZip === 'undefined') {
      alert('JSZip library failed to load. Please check internet connection.');
      return;
    }

    dom.dropzone.classList.add('hidden');
    dom.zippingProgress.classList.remove('hidden');
    dom.zippingLabel.textContent = `Packaging ${blobs.length} photos into archive...`;
    dom.zippingFill.style.width = '10%';

    const zip = new JSZip();
    blobs.forEach((blob, idx) => {
      const filename = `frame_${idx.toString().padStart(5, '0')}.jpg`;
      zip.file(filename, blob);
    });

    const content = await zip.generateAsync(
      { type: 'blob', compression: 'STORE' },
      (metadata) => {
        dom.zippingFill.style.width = `${Math.round(metadata.percent)}%`;
      }
    );

    dom.zippingProgress.classList.add('hidden');
    dom.dropzone.classList.remove('hidden');

    const zipFile = new File([content], zipFilename, { type: 'application/zip' });
    setStagedFile(zipFile);
    switchTab('upload-pane');
  }

  // ---------------------------------------------------------------------------
  // File Upload & Dropzone
  // ---------------------------------------------------------------------------
  function setStagedFile(file) {
    state.stagedFile = file;
    dom.selectedFileName.textContent = file.name;
    dom.selectedFileMeta.textContent = formatBytes(file.size);

    const ext = file.name.split('.').pop().toLowerCase();
    if (['mp4', 'mov', 'webm', 'm4v'].includes(ext)) {
      dom.selectedFileIcon.textContent = '🎬';
    } else if (ext === 'zip') {
      dom.selectedFileIcon.textContent = '📦';
    } else {
      dom.selectedFileIcon.textContent = '🖼️';
    }

    dom.selectedFileCard.classList.remove('hidden');
    dom.launchPipelineBtn.disabled = false;
  }

  function clearStagedFile() {
    state.stagedFile = null;
    dom.selectedFileCard.classList.add('hidden');
    dom.launchPipelineBtn.disabled = true;
    dom.fileInput.value = '';
  }

  dom.removeFileBtn.addEventListener('click', clearStagedFile);
  dom.browseFilesBtn.addEventListener('click', () => dom.fileInput.click());

  async function handleFilesSelected(files) {
    if (!files || files.length === 0) return;

    if (files.length === 1) {
      const file = files[0];
      const ext = file.name.split('.').pop().toLowerCase();
      if (['mp4', 'mov', 'webm', 'm4v', 'zip'].includes(ext)) {
        setStagedFile(file);
        return;
      }
    }

    // Multiple files (photos) or single images dropped -> auto-bundle into .zip!
    const imageFiles = Array.from(files).filter((f) =>
      /\.(jpe?g|png|webp|heic|bmp)$/i.test(f.name)
    );

    if (imageFiles.length > 0) {
      await packageBlobsIntoZip(imageFiles, `photos_bundle_${Date.now()}.zip`);
    } else {
      alert('Please upload a video file (.mp4, .mov, .webm), a .zip archive, or multiple image photos.');
    }
  }

  dom.fileInput.addEventListener('change', (e) => {
    handleFilesSelected(e.target.files);
  });

  // Drag and Drop Events
  ['dragenter', 'dragover'].forEach((eventName) => {
    dom.dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dom.dropzone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    dom.dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dom.dropzone.classList.remove('drag-over');
    });
  });

  dom.dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) {
      handleFilesSelected(e.dataTransfer.files);
    }
  });

  // ---------------------------------------------------------------------------
  // Training Steps Presets
  // ---------------------------------------------------------------------------
  dom.iterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      dom.iterBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const val = btn.dataset.iter;
      dom.iterationsValue.value = val;
      dom.statIterations.textContent = parseInt(val, 10).toLocaleString();
    });
  });

  // ---------------------------------------------------------------------------
  // Pipeline Stepper Progress & State
  // ---------------------------------------------------------------------------
  const STAGES = [
    'queued',
    'extracting_frames',
    'estimating_poses',
    'training',
    'exporting',
    'done',
  ];

  const STAGE_PROGRESS = {
    queued: 12,
    extracting_frames: 28,
    estimating_poses: 50,
    training: 82,
    exporting: 95,
    done: 100,
  };

  const STAGE_DESCRIPTIONS = {
    queued: 'Job queued. Allocating serverless GPU container on Modal...',
    extracting_frames: 'Extracting frames at 2 FPS and scaling to max 1600px...',
    estimating_poses: 'COLMAP is matching visual features & calculating camera poses...',
    training: 'Optimizing 3D Gaussian Splats with splatfacto (Nerfstudio)...',
    exporting: 'Synthesizing Gaussian Splat .ply point cloud...',
    done: '3D model reconstruction complete!',
  };

  function updateStepper(currentStage) {
    const stageIdx = STAGES.indexOf(currentStage);
    if (stageIdx === -1) return;

    STAGES.forEach((stage, idx) => {
      const node = document.getElementById(`step-${stage}`);
      if (!node) return;
      if (idx < stageIdx) {
        node.className = 'step-node completed';
      } else if (idx === stageIdx) {
        node.className = 'step-node active';
      } else {
        node.className = 'step-node';
      }
    });

    const percent = STAGE_PROGRESS[currentStage] || 15;
    dom.mainProgressBar.style.width = `${percent}%`;
    dom.trackingStatusDesc.textContent = STAGE_DESCRIPTIONS[currentStage] || currentStage;
  }

  // ---------------------------------------------------------------------------
  // Pipeline Execution & Status Polling
  // ---------------------------------------------------------------------------
  async function launchPipeline() {
    if (!state.stagedFile) {
      alert('Please select or record a video or set of photos first.');
      return;
    }

    dom.launchPipelineBtn.disabled = true;
    dom.launchPipelineBtn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span> Uploading capture...';

    const iterations = parseInt(dom.iterationsValue.value, 10) || 15000;
    const formData = new FormData();
    formData.append('file', state.stagedFile);

    const uploadUrl = state.apiBase ? `${state.apiBase}/upload?iterations=${iterations}` : `/upload?iterations=${iterations}`;

    try {
      const res = await fetch(uploadUrl, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.detail || `Upload failed with HTTP ${res.status}`);
      }

      const data = await res.json();
      state.activeJobId = data.job_id;
      dom.jobIdLabel.textContent = state.activeJobId;

      // Reveal tracking section
      dom.captureSection.classList.add('hidden');
      dom.errorSection.classList.add('hidden');
      dom.resultsSection.classList.add('hidden');
      dom.trackingSection.classList.remove('hidden');

      // Reset logs and metrics
      dom.terminalLogs.innerHTML = '';
      appendLog(`Uploaded ${state.stagedFile.name} (${formatBytes(state.stagedFile.size)})`, 'success');
      appendLog(`Job initialized with ID: ${state.activeJobId}`, 'info');

      // Start elapsed timer
      state.jobStartTime = Date.now();
      state.elapsedTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - state.jobStartTime) / 1000);
        dom.elapsedTimeCounter.textContent = formatTime(elapsed);
      }, 1000);

      // Start polling
      updateStepper('queued');
      startPolling();
    } catch (err) {
      console.error('Launch failed:', err);
      dom.launchPipelineBtn.disabled = false;
      dom.launchPipelineBtn.innerHTML = '<span class="btn-icon-sparkle">✨</span> Generate 3D Gaussian Splat';
      alert(`Could not start reconstruction: ${err.message}`);
    }
  }

  dom.launchPipelineBtn.addEventListener('click', launchPipeline);

  function startPolling() {
    if (state.pollingInterval) clearInterval(state.pollingInterval);

    let lastStage = null;

    const poll = async () => {
      if (!state.activeJobId) return;
      const statusUrl = state.apiBase
        ? `${state.apiBase}/status/${state.activeJobId}`
        : `/status/${state.activeJobId}`;

      try {
        const res = await fetch(statusUrl);
        if (!res.ok) return;

        const data = await res.json();
        const currentStage = data.status;
        const details = data.details || {};

        if (currentStage !== lastStage) {
          appendLog(`Stage advanced to: [${currentStage.toUpperCase()}]`, 'info');
          lastStage = currentStage;
          updateStepper(currentStage);
        }

        // Update real-time stats
        if (details.extracted_frames_count !== undefined) {
          dom.statExtractedFrames.textContent = details.extracted_frames_count;
        }
        if (details.registered_frames_count !== undefined) {
          dom.statRegisteredPoses.textContent = details.registered_frames_count;
        }

        if (currentStage === 'done') {
          handleJobDone(data);
        } else if (currentStage === 'failed') {
          handleJobFailed(data);
        }
      } catch (err) {
        console.warn('Status poll warning:', err);
      }
    };

    // Immediate first check, then every 3 seconds
    poll();
    state.pollingInterval = setInterval(poll, 3000);
  }

  function stopTracking() {
    if (state.pollingInterval) {
      clearInterval(state.pollingInterval);
      state.pollingInterval = null;
    }
    if (state.elapsedTimer) {
      clearInterval(state.elapsedTimer);
      state.elapsedTimer = null;
    }
  }

  function handleJobDone(data) {
    stopTracking();
    updateStepper('done');
    appendLog('Reconstruction finished successfully! Model is ready for download.', 'success');

    const downloadUrl = state.apiBase
      ? `${state.apiBase}/result/${state.activeJobId}`
      : `/result/${state.activeJobId}`;

    dom.downloadPlyBtn.href = downloadUrl;
    dom.downloadPlyBtn.download = `chaukhat_${state.activeJobId}_model.ply`;

    const details = data.details || {};
    if (details.file_size_bytes) {
      dom.downloadFileSize.textContent = formatBytes(details.file_size_bytes);
    } else {
      dom.downloadFileSize.textContent = 'Ready (.ply)';
    }

    setTimeout(() => {
      dom.trackingSection.classList.add('hidden');
      dom.resultsSection.classList.remove('hidden');
      dom.resultsSection.scrollIntoView({ behavior: 'smooth' });
    }, 1200);
  }

  function handleJobFailed(data) {
    stopTracking();
    const errorMsg = data.error || 'Pipeline encountered an unexpected error.';
    appendLog(`Job failed: ${errorMsg}`, 'error');

    dom.errorMessageText.textContent = errorMsg;
    dom.trackingSection.classList.add('hidden');
    dom.errorSection.classList.remove('hidden');
    dom.errorSection.scrollIntoView({ behavior: 'smooth' });
  }

  // ---------------------------------------------------------------------------
  // Reset Workspace
  // ---------------------------------------------------------------------------
  function resetWorkspace() {
    stopTracking();
    clearStagedFile();
    state.activeJobId = null;
    dom.launchPipelineBtn.disabled = true;
    dom.launchPipelineBtn.innerHTML = '<span class="btn-icon-sparkle">✨</span> Generate 3D Gaussian Splat';

    dom.resultsSection.classList.add('hidden');
    dom.errorSection.classList.add('hidden');
    dom.trackingSection.classList.add('hidden');
    dom.captureSection.classList.remove('hidden');
    dom.captureSection.scrollIntoView({ behavior: 'smooth' });
  }

  dom.resetWorkspaceBtn.addEventListener('click', resetWorkspace);
  dom.errorRetryBtn.addEventListener('click', resetWorkspace);

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------
  window.addEventListener('DOMContentLoaded', () => {
    initApiBase();
  });
})();
