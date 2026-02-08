const App = {
  currentPage: 'dashboard',

  // === Navigation ===
  navigateTo(page) {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));

    document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
    document.getElementById(`page-${page}`)?.classList.add('active');

    this.currentPage = page;
    this.loadPageData(page);
  },

  loadPageData(page) {
    switch (page) {
      case 'dashboard': this.loadDashboard(); break;
      case 'podcasts': this.loadPodcasts(); break;
      case 'documents': this.loadDocuments(); break;
      case 'scheduler': this.loadSchedulerStatus(); break;
      case 'logs': this.loadLogs(); break;
      case 'settings': this.loadSettings(); break;
    }
  },

  // === API Helper ===
  async api(url, options = {}) {
    try {
      const response = await fetch(`/api${url}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Request failed');
      return data.data;
    } catch (error) {
      this.toast(error.message, 'error');
      throw error;
    }
  },

  // === Dashboard ===
  async loadDashboard() {
    try {
      const stats = await this.api('/stats');
      document.getElementById('stat-podcasts').textContent = stats.activePodcasts;
      document.getElementById('stat-episodes').textContent = stats.totalEpisodes;
      document.getElementById('stat-processed').textContent = stats.processedEpisodes;
      document.getElementById('stat-pending').textContent = stats.pendingEpisodes;

      const info = document.getElementById('system-info');
      info.innerHTML = `
        <div class="settings-grid">
          <div class="settings-item"><span class="label">内存使用</span><span class="value">${stats.memory.heapUsedMB}MB / ${stats.memory.heapTotalMB}MB</span></div>
          <div class="settings-item"><span class="label">运行时间</span><span class="value">${this.formatUptime(stats.uptime)}</span></div>
          <div class="settings-item"><span class="label">调度器</span><span class="value">${stats.scheduler.running ? '<span class="badge badge-success">运行中</span>' : '<span class="badge badge-warning">已停止</span>'}</span></div>
          <div class="settings-item"><span class="label">失败任务</span><span class="value">${stats.failedEpisodes}</span></div>
        </div>
      `;
    } catch (e) { /* handled in api() */ }
  },

  // === Podcasts ===
  async loadPodcasts() {
    try {
      const podcasts = await this.api('/podcasts');
      const container = document.getElementById('podcasts-list');

      if (podcasts.length === 0) {
        container.innerHTML = '<div class="empty-state">暂无订阅的播客，点击上方按钮添加</div>';
        return;
      }

      container.innerHTML = podcasts.map(p => `
        <div class="podcast-card">
          <div class="podcast-card-header">
            <img src="${p.image_url || 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 60 60%22><rect fill=%22%23e2e8f0%22 width=%2260%22 height=%2260%22/><text x=%2230%22 y=%2235%22 text-anchor=%22middle%22 font-size=%2224%22>🎙️</text></svg>'}" alt="${p.name}">
            <div class="podcast-card-info">
              <h4>${this.escapeHtml(p.name)}</h4>
              <p>${this.escapeHtml(p.description || p.author || '')}</p>
            </div>
          </div>
          <div class="podcast-card-meta">
            <span>${p.language || 'zh-CN'} · ${p.category || '未分类'}</span>
            <div class="actions">
              <button class="btn btn-sm btn-secondary" onclick="App.refreshPodcast(${p.id})">🔄 刷新</button>
              <button class="btn btn-sm btn-primary" onclick="App.processPodcast(${p.id})">▶️ 处理</button>
              <button class="btn btn-sm btn-danger" onclick="App.deletePodcast(${p.id}, '${this.escapeHtml(p.name)}')">🗑️</button>
            </div>
          </div>
        </div>
      `).join('');
    } catch (e) { /* handled */ }
  },

  async searchPodcasts() {
    const query = document.getElementById('podcast-search-input').value.trim();
    if (!query) return;

    const container = document.getElementById('search-results');
    container.innerHTML = '搜索中...';

    try {
      const results = await this.api(`/podcasts/search?q=${encodeURIComponent(query)}`);
      if (results.length === 0) {
        container.innerHTML = '<p style="color:#64748b;font-size:13px;">未找到相关播客</p>';
        return;
      }
      container.innerHTML = results.map(r => `
        <div class="search-result-item" onclick="App.addPodcastFromSearch('${this.escapeHtml(r.feedUrl)}', '${this.escapeHtml(r.name)}')">
          <img src="${r.artworkUrl || ''}" alt="">
          <div class="search-result-info">
            <h5>${this.escapeHtml(r.name)}</h5>
            <p>${this.escapeHtml(r.author)} · ${this.escapeHtml(r.genre)}</p>
          </div>
        </div>
      `).join('');
    } catch (e) { container.innerHTML = ''; }
  },

  async addPodcastFromSearch(feedUrl, name) {
    try {
      await this.api('/podcasts', { method: 'POST', body: { rssUrl: feedUrl, name } });
      this.toast(`已添加: ${name}`, 'success');
      this.closeModal('modal-add-podcast');
      this.loadPodcasts();
    } catch (e) { /* handled */ }
  },

  async addPodcastByUrl() {
    const url = document.getElementById('rss-url-input').value.trim();
    if (!url) { this.toast('请输入 RSS URL', 'error'); return; }

    try {
      const podcast = await this.api('/podcasts', { method: 'POST', body: { rssUrl: url } });
      this.toast(`已添加: ${podcast.name}`, 'success');
      this.closeModal('modal-add-podcast');
      this.loadPodcasts();
    } catch (e) { /* handled */ }
  },

  async refreshPodcast(id) {
    try {
      const result = await this.api(`/podcasts/${id}/refresh`, { method: 'POST' });
      this.toast(`刷新完成，新增 ${result.newEpisodes} 集`, 'success');
    } catch (e) { /* handled */ }
  },

  async processPodcast(id) {
    try {
      const result = await this.api(`/podcasts/${id}/process`, { method: 'POST' });
      this.toast(`${result.podcastName}: ${result.message}`, 'success');
      // Start polling for progress
      if (result.taskLogId) {
        this.pollTaskProgress(result.taskLogId);
      }
    } catch (e) { /* handled */ }
  },

  pollTaskProgress(taskLogId) {
    const interval = setInterval(async () => {
      try {
        const logs = await this.api('/logs?limit=10');
        const task = logs.find(l => l.id === taskLogId);
        if (task && (task.status === 'completed' || task.status === 'failed')) {
          clearInterval(interval);
          const msg = task.status === 'completed'
            ? `处理完成: ${task.processed_episodes} 成功, ${task.failed_episodes} 失败`
            : `处理失败: ${task.error_details || '未知错误'}`;
          this.toast(msg, task.status === 'completed' ? 'success' : 'error');
          if (this.currentPage === 'dashboard') this.loadDashboard();
          if (this.currentPage === 'documents') this.loadDocuments();
        }
      } catch (e) { clearInterval(interval); }
    }, 5000);
    // Auto-stop polling after 10 minutes
    setTimeout(() => clearInterval(interval), 600000);
  },

  async deletePodcast(id, name) {
    if (!confirm(`确定删除播客「${name}」？此操作不可恢复。`)) return;
    try {
      await this.api(`/podcasts/${id}`, { method: 'DELETE' });
      this.toast('已删除', 'success');
      this.loadPodcasts();
    } catch (e) { /* handled */ }
  },

  showAddPodcastModal() {
    document.getElementById('podcast-search-input').value = '';
    document.getElementById('rss-url-input').value = '';
    document.getElementById('search-results').innerHTML = '';
    this.openModal('modal-add-podcast');
  },

  showImportOPMLModal() {
    document.getElementById('opml-content').value = '';
    document.getElementById('opml-results').innerHTML = '';
    this.openModal('modal-import-opml');
  },

  async importOPML() {
    const content = document.getElementById('opml-content').value.trim();
    if (!content) { this.toast('请粘贴 OPML 内容', 'error'); return; }

    try {
      const feeds = await this.api('/podcasts/import-opml', { method: 'POST', body: { content } });
      const container = document.getElementById('opml-results');
      container.innerHTML = `
        <p>发现 ${feeds.length} 个播客：</p>
        ${feeds.map(f => `
          <div class="search-result-item" onclick="App.addPodcastFromSearch('${this.escapeHtml(f.feedUrl)}', '${this.escapeHtml(f.name)}')">
            <div class="search-result-info">
              <h5>${this.escapeHtml(f.name)}</h5>
              <p style="font-size:11px;color:#64748b;word-break:break-all;">${this.escapeHtml(f.feedUrl)}</p>
            </div>
          </div>
        `).join('')}
      `;
    } catch (e) { /* handled */ }
  },

  // === Documents ===
  async loadDocuments() {
    try {
      const docs = await this.api('/documents');
      const sidebar = document.getElementById('doc-sidebar');

      if (docs.length === 0) {
        sidebar.innerHTML = '<div class="empty-state">暂无文档</div>';
        return;
      }

      sidebar.innerHTML = docs.map(group => `
        <div class="doc-group">
          <h4>📂 ${this.escapeHtml(group.podcast)}</h4>
          ${group.files.map(f => `
            <div class="doc-item" onclick="App.viewDocument('${this.escapeHtml(group.podcast)}', '${f}')" data-doc="${group.podcast}/${f}">
              ${f}
            </div>
          `).join('')}
        </div>
      `).join('');
    } catch (e) { /* handled */ }
  },

  async viewDocument(podcast, filename) {
    try {
      const doc = await this.api(`/documents/${encodeURIComponent(podcast)}/${encodeURIComponent(filename)}`);
      const viewer = document.getElementById('doc-viewer');

      // Mark active
      document.querySelectorAll('.doc-item').forEach(el => el.classList.remove('active'));
      document.querySelector(`.doc-item[data-doc="${podcast}/${filename}"]`)?.classList.add('active');

      const html = marked.parse(doc.content);
      viewer.innerHTML = `
        <div class="actions" style="margin-bottom:16px;">
          <button class="btn btn-sm btn-pdf" onclick="App.exportPdf('${this.escapeHtml(podcast)}', '${filename}')">📥 导出PDF</button>
          <button class="btn btn-sm btn-secondary" onclick="App.downloadMarkdown('${this.escapeHtml(podcast)}', '${filename}')">📄 下载MD</button>
        </div>
        ${html}
      `;
    } catch (e) { /* handled */ }
  },

  async exportPdf(podcast, filename) {
    this.toast('正在生成 PDF...', 'info');
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(podcast)}/${encodeURIComponent(filename)}/pdf`, { method: 'POST' });
      if (!response.ok) throw new Error('PDF export failed');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename.replace('.md', '.pdf');
      a.click();
      URL.revokeObjectURL(url);
      this.toast('PDF 导出成功', 'success');
    } catch (e) {
      this.toast(`PDF 导出失败: ${e.message}`, 'error');
    }
  },

  async downloadMarkdown(podcast, filename) {
    try {
      const doc = await this.api(`/documents/${encodeURIComponent(podcast)}/${encodeURIComponent(filename)}`);
      const blob = new Blob([doc.content], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { /* handled */ }
  },

  // === Scheduler ===
  async loadSchedulerStatus() {
    try {
      const status = await this.api('/scheduler/status');
      const container = document.getElementById('scheduler-status');

      container.innerHTML = `
        <div class="scheduler-info">
          <div class="scheduler-item">
            <div class="label">运行状态</div>
            <div>${status.running ? '<span class="badge badge-success">运行中</span>' : '<span class="badge badge-warning">已停止</span>'}</div>
          </div>
          <div class="scheduler-item">
            <div class="label">任务状态</div>
            <div>${status.taskRunning ? '<span class="badge badge-info">处理中</span>' : '<span class="badge badge-success">空闲</span>'}</div>
          </div>
          <div class="scheduler-item">
            <div class="label">Cron 表达式</div>
            <div>${status.cron}</div>
          </div>
          <div class="scheduler-item">
            <div class="label">时区</div>
            <div>${status.timezone}</div>
          </div>
          <div class="scheduler-item">
            <div class="label">上次运行</div>
            <div>${status.lastRunTime ? new Date(status.lastRunTime).toLocaleString('zh-CN') : '暂未运行'}</div>
          </div>
          <div class="scheduler-item">
            <div class="label">上次状态</div>
            <div>${status.lastRunStatus || '-'}</div>
          </div>
        </div>
        <h3 style="margin-top:24px;font-size:16px;">📧 邮件摘要调度</h3>
        <div class="scheduler-info" style="margin-top:12px;">
          <div class="scheduler-item">
            <div class="label">邮件功能</div>
            <div>${status.emailEnabled ? '<span class="badge badge-success">已启用</span>' : '<span class="badge badge-warning">未启用</span>'}</div>
          </div>
          <div class="scheduler-item">
            <div class="label">邮件调度器</div>
            <div>${status.emailSchedulerRunning ? '<span class="badge badge-success">运行中</span>' : '<span class="badge badge-warning">已停止</span>'}</div>
          </div>
          <div class="scheduler-item">
            <div class="label">发送时间</div>
            <div>${status.emailCron} (${status.emailEnabled ? '每天8:00 北京时间' : '未配置'})</div>
          </div>
          <div class="scheduler-item">
            <div class="label">上次发送</div>
            <div>${status.lastEmailTime ? new Date(status.lastEmailTime).toLocaleString('zh-CN') : '暂未发送'}</div>
          </div>
          <div class="scheduler-item">
            <div class="label">发送结果</div>
            <div>${status.lastEmailStatus || '-'}</div>
          </div>
        </div>
        <div style="margin-top:12px;">
          <button class="btn btn-sm btn-secondary" onclick="App.testEmailConnection()">🔌 测试连接</button>
          <button class="btn btn-sm btn-primary" onclick="App.sendTestDigest()">📤 立即发送摘要</button>
        </div>
      `;

      const btn = document.getElementById('btn-scheduler-toggle');
      btn.textContent = status.running ? '⏹️ 停止调度器' : '▶️ 启动调度器';
      btn.className = status.running ? 'btn btn-danger' : 'btn btn-primary';
    } catch (e) { /* handled */ }
  },

  async toggleScheduler() {
    try {
      const status = await this.api('/scheduler/status');
      if (status.running) {
        await this.api('/scheduler/stop', { method: 'POST' });
        this.toast('调度器已停止', 'info');
      } else {
        await this.api('/scheduler/start', { method: 'POST' });
        this.toast('调度器已启动', 'success');
      }
      this.loadSchedulerStatus();
    } catch (e) { /* handled */ }
  },

  async triggerManualRun() {
    if (!confirm('确定立即运行全量处理？')) return;
    this.toast('开始手动处理...', 'info');
    try {
      await this.api('/scheduler/trigger', { method: 'POST' });
      this.toast('手动处理完成', 'success');
      this.loadSchedulerStatus();
    } catch (e) { /* handled */ }
  },

  // === Pipeline ===
  async runPipeline() {
    if (!confirm('确定立即运行全量处理？')) return;
    try {
      const result = await this.api('/pipeline/run', { method: 'POST' });
      this.toast(result.message, 'success');
      if (result.taskLogId) {
        this.pollTaskProgress(result.taskLogId);
      }
    } catch (e) { /* handled */ }
  },

  // === Logs ===
  async loadLogs() {
    try {
      const logs = await this.api('/logs');
      const container = document.getElementById('logs-list');

      if (logs.length === 0) {
        container.innerHTML = '<div class="empty-state">暂无运行日志</div>';
        return;
      }

      container.innerHTML = `
        <table class="logs-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>状态</th>
              <th>处理数</th>
              <th>失败数</th>
              <th>耗时</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            ${logs.map(log => `
              <tr>
                <td>${log.started_at ? new Date(log.started_at).toLocaleString('zh-CN') : '-'}</td>
                <td>${this.escapeHtml(log.task_type)}</td>
                <td>${this.statusBadge(log.status)}</td>
                <td>${log.processed_episodes}/${log.total_episodes}</td>
                <td>${log.failed_episodes}</td>
                <td>${log.duration_ms ? (log.duration_ms / 1000).toFixed(1) + 's' : '-'}</td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;">${this.escapeHtml(log.error_details || '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } catch (e) { /* handled */ }
  },

  // === Email ===
  async testEmailConnection() {
    this.toast('正在测试SMTP连接...', 'info');
    try {
      const result = await this.api('/email/test-connection', { method: 'POST' });
      if (result.success) {
        this.toast('SMTP连接成功！', 'success');
      } else {
        this.toast(`SMTP连接失败: ${result.error}`, 'error');
      }
    } catch (e) { /* handled */ }
  },

  async sendTestDigest() {
    this.toast('正在发送邮件摘要...', 'info');
    try {
      const result = await this.api('/email/send-digest', { method: 'POST' });
      if (result.sent) {
        this.toast(`邮件发送成功！包含 ${result.episodeCount} 个剧集`, 'success');
      } else {
        this.toast(`发送失败: ${result.error}`, 'error');
      }
    } catch (e) { /* handled */ }
  },

  // === Settings ===
  async loadSettings() {
    try {
      const settings = await this.api('/settings');
      const container = document.getElementById('settings-content');

      container.innerHTML = `
        <div class="settings-grid">
          <div class="settings-item"><span class="label">转录服务</span><span class="value">${settings.transcriptionProvider}</span></div>
          <div class="settings-item"><span class="label">分析服务</span><span class="value">${settings.analysisProvider}</span></div>
          <div class="settings-item"><span class="label">分析模型</span><span class="value">${settings.openaiModel}</span></div>
          <div class="settings-item"><span class="label">Cron 表达式</span><span class="value">${settings.schedulerCron}</span></div>
          <div class="settings-item"><span class="label">时区</span><span class="value">${settings.schedulerTimezone}</span></div>
          <div class="settings-item"><span class="label">最大并发</span><span class="value">${settings.maxConcurrentFeeds}</span></div>
          <div class="settings-item"><span class="label">更新窗口</span><span class="value">${settings.updateWindowHours} 小时</span></div>
          <div class="settings-item"><span class="label">PDF 导出</span><span class="value">${settings.pdfEnabled ? '✅ 已启用' : '❌ 已禁用'}</span></div>
        </div>
        <h3 style="margin-top:24px;font-size:16px;">📧 邮件设置</h3>
        <div class="settings-grid" style="margin-top:12px;">
          <div class="settings-item"><span class="label">邮件功能</span><span class="value">${settings.emailEnabled ? '✅ 已启用' : '❌ 未启用'}</span></div>
          <div class="settings-item"><span class="label">收件地址</span><span class="value">${settings.emailTo || '未配置'}</span></div>
          <div class="settings-item"><span class="label">发送时间</span><span class="value">${settings.emailCron} (每天8:00 北京时间)</span></div>
          <div class="settings-item"><span class="label">SMTP</span><span class="value">${settings.emailSmtpConfigured ? '✅ 已配置' : '❌ 未配置密码'}</span></div>
        </div>
        <p style="margin-top:16px;font-size:12px;color:#94a3b8;">修改设置请编辑项目根目录下的 .env 文件并重启服务</p>
      `;
    } catch (e) { /* handled */ }
  },

  // === Utilities ===
  openModal(id) { document.getElementById(id).classList.add('active'); },
  closeModal(id) { document.getElementById(id).classList.remove('active'); },

  toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  },

  statusBadge(status) {
    const map = {
      completed: ['badge-success', '完成'],
      running: ['badge-info', '运行中'],
      failed: ['badge-danger', '失败'],
      pending: ['badge-warning', '等待'],
      processing: ['badge-info', '处理中'],
    };
    const [cls, text] = map[status] || ['badge-info', status];
    return `<span class="badge ${cls}">${text}</span>`;
  },

  escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}小时${m}分钟`;
    return `${m}分钟`;
  },
};

// Init
document.addEventListener('DOMContentLoaded', () => {
  // Navigation click handlers
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => App.navigateTo(item.dataset.page));
  });

  // Close modals on backdrop click
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('active');
    });
  });

  // Load initial page
  App.loadDashboard();
});
