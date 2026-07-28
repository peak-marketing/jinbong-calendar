(() => {
  'use strict';

  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyCde38yMmqtxA0RPUivfI1iT5o56ZYqWF0',
    authDomain: 'peakmarketing-3f3a3.firebaseapp.com',
    projectId: 'peakmarketing-3f3a3',
    storageBucket: 'peakmarketing-3f3a3.firebasestorage.app',
    messagingSenderId: '901027878178',
    appId: '1:901027878178:web:7c12ebb7c431cef973817b'
  };

  const body = document.body;
  const dashboardView = document.getElementById('dashboardView');
  const calendarView = document.getElementById('calendarView');
  const chatView = document.getElementById('chatView');
  const todoView = document.getElementById('todoView');
  const reviewView = document.getElementById('reviewView');
  const moduleView = document.getElementById('moduleView');
  const permissionsView = document.getElementById('permissionsView');
  const pageCrumb = document.getElementById('pageCrumb');
  const prototypeBar = document.querySelector('.prototype-bar');
  const toast = document.querySelector('.toast');
  let toastTimer = 0;

  let auth;
  let currentUser = null;
  let userDoc = null;
  let liveEvents = [];
  let liveProjects = [];
  let liveChatRooms = [];
  let liveUnreadCounts = {};
  let eventLoadedYear = null;
  let calendarYear = new Date().getFullYear();
  let calendarMonth = new Date().getMonth() + 1;
  let calendarSelected = localDateKey(new Date());
  let calendarScope = 'all';
  let todoScope = 'all';
  let projectFilter = 'all';
  let chatFilter = 'all';
  let selectedChatRoomId = null;
  let reportType = 'attendance';
  let serviceFilter = 'all';
  let serviceCatalog = [
    { id: 'brand-auto-space', icon: '💻', name: '브랜드오토스페이스', description: '프로그램 판매 사이트', category: 'sales', url: '' },
    { id: 'review-flow', icon: '🛒', name: '리뷰플로우', description: '영수증 리뷰 플랫폼', category: 'review', url: '' },
    { id: 'keyword-master', icon: '🔍', name: '키워드 마스터', description: '키워드 조회 사이트', category: 'tool', url: '' },
    { id: 'peak-intake-ui', icon: '📱', name: '피크 접수 UI', description: '리워드·블로그 접수 UI', category: 'intake', url: '' },
    { id: 'space-shopping', icon: '⚡', name: '스페이스·쇼핑', description: '쇼핑 접수 UI', category: 'intake', url: '' },
    { id: 'writing-program', icon: '📝', name: '원고 프로그램', description: '최적화 글 원고 프로그램', category: 'tool', url: '' },
    { id: 'sns-automation', icon: '🎯', name: 'SNS자동화 사이트', description: '인스타·틱톡 등 자동화 사이트', category: 'automation', url: '' },
    { id: 'naver', icon: '📈', name: '네이버', description: '네이버 운영 바로가기', category: 'operations', url: '' },
    { id: 'daegu-all-in-one', icon: '📊', name: '대구지사 올인원 링크', description: '대구지사 업무 통합 링크', category: 'operations', url: '' },
    { id: 'final-report-settlement', icon: '📊', name: '최종보고정산서', description: '최종 보고 및 정산 자료', category: 'settlement', url: '' },
    { id: 'mobile-naver', icon: '📈', name: '모바일네이버', description: '모바일 네이버 바로가기', category: 'operations', url: '' },
    { id: 'db-site', icon: '💼', name: 'DB사이트', description: '대구지사 영업 및 TM 사이트', category: 'operations', url: '' },
    { id: 'settlement-image', icon: '💰', name: '정산서 이미지', description: '클라이언트 청구용 정산서 이미지 캡처 시트', category: 'settlement', url: '' },
    { id: 'review-space', icon: '🌐', name: '리뷰스페이스', description: '최블 기자단 플랫폼', category: 'review', url: '' },
    { id: 'build-solution', icon: '🤖', name: '빌드 솔루션', description: '홈페이지·브랜드블로그·개발 의뢰 레퍼런스', category: 'sales', url: '' },
    { id: 'reward-space', icon: '💻', name: '리워드 스페이스', description: '오퍼월 B2B 리워드 신규 사이트', category: 'sales', url: '' }
  ];

  const PLANNED_MODULES = {
    reports: 'REPORTS',
    documents: 'DOCUMENTS',
    services: 'SERVICES',
    company: 'COMPANY',
    organization: 'ORGANIZATION',
    settlement: 'SETTLEMENT',
    tax: 'TAX',
    platform: 'PLATFORM',
    saas: 'SAAS HUB'
  };

  const PROJECT_STATUS = {
    planning: ['기획 중', 'planning'],
    active: ['진행 중', 'active'],
    review: ['확인 대기', 'review'],
    done: ['완료', 'done'],
    hold: ['보류', 'hold'],
    archived: ['보관', 'hold']
  };

  const TASK_STATUS = {
    todo: '대기',
    doing: '진행 중',
    review: '검토 요청',
    done: '완료',
    hold: '보류'
  };

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function localDateKey(date) {
    const value = date instanceof Date ? date : new Date(date);
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0')
    ].join('-');
  }

  function formatDate(value, options = {}) {
    if (!value) return '';
    const date = new Date(String(value).length === 10 ? value + 'T00:00:00' : value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('ko-KR', options).format(date);
  }

  function formatTime(value) {
    if (!value) return '시간 미정';
    if (/^\d{2}:\d{2}/.test(value)) {
      const [hour, minute] = value.split(':').map(Number);
      const suffix = hour < 12 ? '오전' : '오후';
      const displayHour = hour % 12 || 12;
      return `${suffix} ${displayHour}:${String(minute).padStart(2, '0')}`;
    }
    return formatDate(value, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function safeAssetUrl(value) {
    const url = String(value || '').trim();
    if (/^https?:\/\//i.test(url) || url.startsWith('/')) return esc(url);
    return '';
  }

  function showToast(message = '이 화면은 운영 데이터 읽기 전용입니다.') {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('show');
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function createAuthGate() {
    const gate = document.createElement('section');
    gate.className = 'auth-gate';
    gate.id = 'authGate';
    gate.innerHTML = `
      <div class="auth-card">
        <div class="auth-logo">P</div>
        <h1>PEAK OS</h1>
        <p>기존 파라곤 계정으로 로그인하면<br>허용된 운영 데이터를 읽기 전용으로 확인할 수 있습니다.</p>
        <button class="auth-google" id="googleSignIn" type="button">Google 계정으로 로그인</button>
        <div class="auth-status" id="authStatus">등록·수정·삭제는 이 화면에서 실행되지 않습니다.</div>
      </div>`;
    body.append(gate);
    gate.querySelector('#googleSignIn').addEventListener('click', signInWithGoogle);
  }

  function createDetailModal() {
    const modal = document.createElement('section');
    modal.className = 'readonly-modal';
    modal.id = 'readonlyDetailModal';
    modal.hidden = true;
    modal.innerHTML = `
      <article class="readonly-modal-card" role="dialog" aria-modal="true" aria-labelledby="readonlyModalTitle">
        <header class="readonly-modal-head">
          <strong id="readonlyModalTitle">상세 정보</strong>
          <button class="readonly-modal-close" id="readonlyModalClose" type="button" aria-label="닫기">×</button>
        </header>
        <div class="readonly-modal-body" id="readonlyModalBody"></div>
      </article>`;
    body.append(modal);
    modal.querySelector('#readonlyModalClose').addEventListener('click', closeDetailModal);
    modal.addEventListener('click', event => {
      if (event.target === modal) closeDetailModal();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !modal.hidden) closeDetailModal();
    });
  }

  function openDetailModal(title, content) {
    document.getElementById('readonlyModalTitle').textContent = title;
    document.getElementById('readonlyModalBody').innerHTML = content;
    document.getElementById('readonlyDetailModal').hidden = false;
    body.style.overflow = 'hidden';
  }

  function closeDetailModal() {
    document.getElementById('readonlyDetailModal').hidden = true;
    body.style.overflow = '';
  }

  function setAuthStatus(message, isError = false) {
    const status = document.getElementById('authStatus');
    status.textContent = message;
    status.classList.toggle('error', isError);
  }

  async function signInWithGoogle() {
    const button = document.getElementById('googleSignIn');
    button.disabled = true;
    setAuthStatus('Google 로그인을 여는 중입니다…');
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await auth.signInWithPopup(provider);
    } catch (error) {
      button.disabled = false;
      if (error.code === 'auth/popup-blocked') {
        await auth.signInWithRedirect(provider);
        return;
      }
      if (error.code === 'auth/popup-closed-by-user') {
        setAuthStatus('로그인이 취소되었습니다.');
        return;
      }
      setAuthStatus(`로그인 실패: ${error.message}`, true);
    }
  }

  async function readOnlyApi(path) {
    if (!currentUser) throw new Error('로그인이 필요합니다.');
    if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('잘못된 조회 경로입니다.');
    const token = await currentUser.getIdToken();
    const response = await fetch('/api' + path, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token },
      cache: 'no-store',
      credentials: 'same-origin'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `조회 실패 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function normalizeEvent(record) {
    return {
      id: record.id,
      type: record.type || 'event',
      title: record.title || '제목 없음',
      date: String(record.date || '').slice(0, 10),
      endDate: String(record.end_date || record.endDate || '').slice(0, 10),
      time: record.time || '',
      memo: record.memo || '',
      todoCat: record.todo_cat ?? record.todoCat ?? '',
      scope: record.scope || 'personal',
      ownerId: record.owner_id ?? record.ownerId,
      ownerName: record.owner_name ?? record.ownerName ?? '',
      isShared: record.is_shared === true || record.isShared === true,
      done: record.done === true,
      projectId: record.project_id ?? record.projectId ?? ''
    };
  }

  async function fetchEventsForYear(year) {
    const data = await readOnlyApi(`/events?from=${year}-01-01&to=${year}-12-31`);
    liveEvents = Array.isArray(data) ? data.map(normalizeEvent) : [];
    eventLoadedYear = year;
  }

  async function loadLiveData() {
    const currentYear = new Date().getFullYear();
    const [events, rooms, unread, projectData] = await Promise.all([
      readOnlyApi(`/events?from=${currentYear}-01-01&to=${currentYear}-12-31`),
      readOnlyApi('/chat-rooms'),
      readOnlyApi('/chat-rooms/unread').catch(() => ({})),
      readOnlyApi('/projects')
    ]);
    liveEvents = Array.isArray(events) ? events.map(normalizeEvent) : [];
    eventLoadedYear = currentYear;
    liveChatRooms = Array.isArray(rooms) ? rooms : [];
    liveUnreadCounts = unread && typeof unread === 'object' ? unread : {};
    liveProjects = Array.isArray(projectData) ? projectData : (projectData.projects || []);
  }

  function roleLabel(role) {
    return { admin: '관리자', manager: '팀장', member: '멤버' }[role] || '멤버';
  }

  function applyUserIdentity() {
    const member = document.querySelector('.app-sidebar > .member');
    const name = userDoc.name || currentUser.displayName || currentUser.email || '사용자';
    const initials = name.slice(-2);
    member.innerHTML = `
      <div class="avatar">${esc(initials)}</div>
      <div class="member-copy"><strong>${esc(name)}</strong><small>${esc(userDoc.group_name || '소속 미지정')} · ${esc(roleLabel(userDoc.role))}</small></div>
      <button class="member-signout" id="memberSignout" type="button" title="로그아웃" aria-label="로그아웃">↪</button>`;
    member.querySelector('#memberSignout').addEventListener('click', async () => {
      await auth.signOut();
      location.reload();
    });
    prototypeBar.classList.add('live');
    prototypeBar.innerHTML = `<i aria-hidden="true"></i> 운영 데이터 · 읽기 전용 · ${esc(name)} 계정 권한으로 조회 중`;
  }

  function updateNavigationBadges() {
    const unreadTotal = Object.values(liveUnreadCounts).reduce((sum, value) => sum + Number(value || 0), 0);
    const today = localDateKey(new Date());
    const todoRemaining = liveEvents.filter(event => event.type === 'todo' && event.date === today && !event.done).length;
    const reviewProjects = liveProjects.filter(project => project.status === 'review').length;
    const chatBadge = document.querySelector('[data-view="chat"] .nav-badge');
    const todoBadge = document.querySelector('[data-view="todo"] .nav-badge');
    const projectBadge = document.querySelector('[data-view="review"] .nav-badge');
    if (chatBadge) chatBadge.textContent = unreadTotal || liveChatRooms.length;
    if (todoBadge) todoBadge.textContent = todoRemaining;
    if (projectBadge) projectBadge.textContent = reviewProjects;
  }

  function eventTypeLabel(event) {
    if (event.type === 'todo') return event.done ? '완료' : '할 일';
    if (event.type === 'meeting') return '회의';
    if (event.type === 'deadline') return '마감';
    return '일정';
  }

  function projectProgress(project) {
    const total = Number(project.task_count || 0);
    const done = Number(project.done_task_count || 0);
    return { total, done, percent: total ? Math.round(done / total * 100) : 0 };
  }

  function renderDashboard() {
    const content = dashboardView.querySelector('.dashboard-grid .content-stack');
    const today = localDateKey(new Date());
    const monthPrefix = today.slice(0, 7);
    const todayTodos = liveEvents.filter(event => event.type === 'todo' && event.date === today);
    const monthEvents = liveEvents.filter(event => event.date.startsWith(monthPrefix));
    const activeProjects = liveProjects.filter(project => ['active', 'planning', 'review'].includes(project.status));
    const unreadTotal = Object.values(liveUnreadCounts).reduce((sum, value) => sum + Number(value || 0), 0);
    const name = userDoc.name || currentUser.displayName || '사용자';
    const todayRows = todayTodos.slice(0, 5).map(event => `
      <div class="live-dashboard-row">
        <span><strong>${esc(event.title)}</strong><small>${esc(event.ownerName || name)} · ${esc(formatTime(event.time))}</small></span>
        <span>${event.done ? '완료' : '진행 중'}</span>
      </div>`).join('');
    const projectRows = activeProjects.slice(0, 5).map(project => {
      const progress = projectProgress(project);
      return `<button class="live-dashboard-row" type="button" data-project-detail="${esc(project.id)}" style="width:100%;border-left:0;border-right:0;border-top:0;background:transparent;text-align:left">
        <span><strong>${esc(project.name)}</strong><small>${esc(project.owner_name || '담당 미지정')} · 업무 ${progress.done}/${progress.total}</small></span>
        <span>${progress.percent}%</span>
      </button>`;
    }).join('');

    content.innerHTML = `
      <section class="sales-context" aria-label="현재 계정 조회 범위">
        <div class="sales-context-user">
          <span class="sales-context-avatar">${esc(roleLabel(userDoc.role))}</span>
          <span class="sales-context-copy">
            <strong>${esc(userDoc.group_name || '소속 미지정')} · ${esc(name)}님</strong>
            <small>기존 파라곤에서 이 계정에 허용된 데이터만 표시됩니다</small>
          </span>
        </div>
        <span class="readonly-badge">읽기 전용</span>
      </section>

      <section class="metric-grid" aria-label="운영 현황">
        <article class="metric-card"><div class="metric-label"><span>오늘 할 일</span><span class="metric-icon">✓</span></div><div class="metric-value">${todayTodos.length}건</div><div class="metric-change">${todayTodos.filter(event => event.done).length}건 완료</div></article>
        <article class="metric-card"><div class="metric-label"><span>이번 달 일정</span><span class="metric-icon">◫</span></div><div class="metric-value">${monthEvents.length}건</div><div class="metric-change">${monthEvents.filter(event => event.scope === 'team').length}건 팀 일정</div></article>
        <article class="metric-card"><div class="metric-label"><span>진행 프로젝트</span><span class="metric-icon">▣</span></div><div class="metric-value">${activeProjects.length}개</div><div class="metric-change">${liveProjects.filter(project => project.status === 'review').length}개 확인 대기</div></article>
        <article class="metric-card"><div class="metric-label"><span>읽지 않은 채팅</span><span class="metric-icon">◌</span></div><div class="metric-value">${unreadTotal}건</div><div class="metric-change neutral">참여 채팅방 ${liveChatRooms.length}개</div></article>
      </section>

      <section class="panel">
        <div class="panel-head"><div><div class="panel-title">매출 · 정산 · 급여 · 세금</div><div class="panel-subtitle">재무 데이터 연결 상태</div></div><span class="readonly-badge">미연결</span></div>
        <div class="section-body">
          <div class="data-unavailable"><span class="data-unavailable-icon">₩</span><div><strong>아직 전달받은 실제 데이터가 없습니다</strong><p>예시 금액은 제거했습니다. 자료 구조와 권한 범위가 확정되면 해당 계정에 허용된 실제 값만 이 자리에 연결할 수 있습니다.</p></div></div>
        </div>
      </section>

      <div class="split-grid">
        <section class="panel">
          <div class="panel-head"><div><div class="panel-title">오늘 할 일</div><div class="panel-subtitle">${formatDate(today, { year: 'numeric', month: 'long', day: 'numeric' })}</div></div><button class="live-panel-link" type="button" data-go-view="todo">전체보기</button></div>
          <div class="live-dashboard-list">${todayRows || '<div class="live-list-empty">오늘 등록된 할 일이 없습니다.</div>'}</div>
        </section>
        <section class="panel">
          <div class="panel-head"><div><div class="panel-title">진행 중인 프로젝트</div><div class="panel-subtitle">내 권한으로 조회 가능한 프로젝트</div></div><button class="live-panel-link" type="button" data-go-view="review">전체보기</button></div>
          <div class="live-dashboard-list">${projectRows || '<div class="live-list-empty">진행 중인 프로젝트가 없습니다.</div>'}</div>
        </section>
      </div>`;

    content.querySelectorAll('[data-go-view]').forEach(button => button.addEventListener('click', () => activateView(button.dataset.goView)));
    content.querySelectorAll('[data-project-detail]').forEach(button => button.addEventListener('click', () => openProjectDetail(button.dataset.projectDetail)));
  }

  function calendarEventsForScope() {
    if (calendarScope === 'team') return liveEvents.filter(event => event.scope === 'team');
    if (calendarScope === 'personal') return liveEvents.filter(event => event.scope !== 'team');
    return liveEvents;
  }

  function renderCalendarAgenda() {
    const agenda = document.getElementById('homeCalendarAgenda');
    const selectedEvents = calendarEventsForScope().filter(event => event.date === calendarSelected);
    const selectedDate = new Date(calendarSelected + 'T00:00:00');
    agenda.innerHTML = `
      <div class="agenda-date"><strong>${selectedDate.getDate()}</strong><span>${formatDate(selectedDate, { month: 'long', weekday: 'long' })}</span></div>
      <div class="agenda-list">
        ${selectedEvents.length ? selectedEvents.map(event => `
          <button class="agenda-item" type="button" data-event-detail="${esc(event.id)}">
            <span class="agenda-time">${esc(formatTime(event.time))}</span>
            <span class="agenda-copy"><strong>${esc(event.title)}</strong><small>${esc(event.ownerName || '담당자 미지정')} · ${esc(eventTypeLabel(event))}</small></span>
          </button>`).join('') : '<div class="live-list-empty">이 날짜에 일정이 없습니다.</div>'}
      </div>
      <span class="todo-readonly-note">운영 데이터 · 읽기 전용</span>`;
    agenda.querySelectorAll('[data-event-detail]').forEach(button => button.addEventListener('click', () => {
      const event = liveEvents.find(item => String(item.id) === String(button.dataset.eventDetail));
      if (event) openEventDetail(event);
    }));
  }

  function renderCalendar() {
    const grid = document.getElementById('homeCalendarGrid');
    const monthEvents = calendarEventsForScope().filter(event => event.date.startsWith(`${calendarYear}-${String(calendarMonth).padStart(2, '0')}`));
    const firstDay = new Date(calendarYear, calendarMonth - 1, 1).getDay();
    const days = new Date(calendarYear, calendarMonth, 0).getDate();
    const previousDays = new Date(calendarYear, calendarMonth - 1, 0).getDate();
    const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
    const cells = weekdays.map(day => `<div class="home-calendar-weekday">${day}</div>`);

    for (let offset = firstDay - 1; offset >= 0; offset -= 1) {
      cells.push(`<button class="home-calendar-cell other" type="button" disabled><span class="calendar-date-line"><span class="calendar-date">${previousDays - offset}</span></span></button>`);
    }
    for (let day = 1; day <= days; day += 1) {
      const key = `${calendarYear}-${String(calendarMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const dateEvents = monthEvents.filter(event => event.date === key);
      const weekday = new Date(calendarYear, calendarMonth - 1, day).getDay();
      const eventMarkup = dateEvents.slice(0, 2).map(event => `<span class="calendar-event ${esc(event.type)}"><i></i><span>${esc(event.title)}</span></span>`).join('');
      cells.push(`
        <button class="home-calendar-cell ${dateEvents.length ? 'has-events' : ''} ${key === localDateKey(new Date()) ? 'today' : ''} ${key === calendarSelected ? 'selected' : ''} ${weekday === 0 ? 'sun' : ''} ${weekday === 6 ? 'sat' : ''}" type="button" data-date="${key}">
          <span class="calendar-date-line"><span class="calendar-date">${day}</span>${dateEvents.length ? `<span class="calendar-count">${dateEvents.length}</span>` : ''}</span>
          <span class="calendar-events">${eventMarkup}</span>${dateEvents.length > 2 ? `<span class="calendar-more">+${dateEvents.length - 2}개 더보기</span>` : ''}
        </button>`);
    }
    const used = firstDay + days;
    for (let day = 1; day <= 42 - used; day += 1) {
      cells.push(`<button class="home-calendar-cell other" type="button" disabled><span class="calendar-date-line"><span class="calendar-date">${day}</span></span></button>`);
    }
    grid.innerHTML = cells.join('');
    document.getElementById('calendarMonthLabel').textContent = `${calendarYear}년 ${calendarMonth}월`;
    document.getElementById('calendarMonthCount').textContent = `이번 달 일정 ${monthEvents.length}건`;
    grid.querySelectorAll('[data-date]').forEach(cell => cell.addEventListener('click', () => {
      calendarSelected = cell.dataset.date;
      renderCalendar();
    }));
    renderCalendarAgenda();
    updateCalendarSummary();
  }

  function updateCalendarSummary() {
    const cards = calendarView.querySelectorAll('.permission-stat');
    const monthPrefix = `${calendarYear}-${String(calendarMonth).padStart(2, '0')}`;
    const monthEvents = calendarEventsForScope().filter(event => event.date.startsWith(monthPrefix));
    const unfinished = monthEvents.filter(event => event.type === 'todo' && !event.done);
    const teamEvents = monthEvents.filter(event => event.scope === 'team');
    const meetings = monthEvents.filter(event => event.type === 'meeting');
    const values = [
      [monthEvents.length, '선택 범위의 월간 일정'],
      [unfinished.length, '선택 범위의 미완료 업무'],
      [teamEvents.length, '팀 범위로 등록된 일정'],
      [meetings.length, '이번 달 회의 일정']
    ];
    cards.forEach((card, index) => {
      card.querySelector('strong').textContent = values[index][0];
      card.querySelector('small').textContent = values[index][1];
    });
  }

  function openEventDetail(event) {
    openDetailModal(event.title, `
      <div class="readonly-detail-meta">
        <span>${esc(eventTypeLabel(event))}</span><span>${esc(event.scope === 'team' ? '팀 일정' : '내 일정')}</span>${event.projectId ? '<span>프로젝트 연결</span>' : ''}
      </div>
      <p class="readonly-detail-copy"><strong>일시</strong><br>${esc(formatDate(event.date, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }))} · ${esc(formatTime(event.time))}</p>
      <p class="readonly-detail-copy"><strong>담당</strong><br>${esc(event.ownerName || '담당자 미지정')}</p>
      <p class="readonly-detail-copy"><strong>설명</strong><br>${esc(event.memo || '등록된 설명이 없습니다.')}</p>
      <span class="readonly-badge">읽기 전용</span>`);
  }

  function renderTodo() {
    const today = localDateKey(new Date());
    let items = liveEvents.filter(event => event.type === 'todo' && event.date === today);
    if (todoScope === 'team') items = items.filter(event => event.scope === 'team');
    if (todoScope === 'personal') items = items.filter(event => event.scope !== 'team');
    const done = items.filter(event => event.done).length;
    const grouped = new Map();
    items.forEach(event => {
      const key = event.todoCat || (event.scope === 'team' ? '팀 업무' : `${event.ownerName || '내'} 업무`);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(event);
    });
    const groupMarkup = [...grouped.entries()].map(([name, events]) => {
      const groupDone = events.filter(event => event.done).length;
      return `<article class="todo-group" data-scope="${events[0]?.scope || 'personal'}">
        <button class="todo-group-head" type="button">
          <span class="todo-group-caret">▼</span><i class="todo-group-dot ${events[0]?.scope === 'team' ? 'teal' : 'red'}"></i>
          <span class="todo-group-title">${esc(name)}</span><span class="todo-group-count">${groupDone}/${events.length}</span>
        </button>
        <div class="todo-group-body">
          ${events.map(event => `
            <div class="todo-task ${event.done ? 'done' : ''}">
              <button class="todo-task-check ${event.done ? 'checked' : ''}" type="button" disabled aria-label="${esc(event.title)} ${event.done ? '완료' : '미완료'}">${event.done ? '✓' : ''}</button>
              <div class="todo-task-main">
                <div class="todo-task-title">${esc(event.title)}</div>
                <div class="todo-task-meta">담당 ${esc(event.ownerName || '미지정')} · ${esc(formatTime(event.time))}</div>
                ${event.memo ? `<div class="todo-task-note">${esc(event.memo)}</div>` : ''}
              </div>
              <div class="todo-task-side"><span class="todo-progress-pill ${event.done ? '' : 'review'}">${event.done ? '완료' : '진행 중'}</span></div>
            </div>`).join('')}
        </div>
      </article>`;
    }).join('');

    todoView.innerHTML = `
      <header class="todo-page-toolbar">
        <div class="todo-date-copy"><strong>${formatDate(today, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}</strong></div>
        <span class="todo-readonly-note">읽기 전용</span>
      </header>
      <nav class="todo-scope-tabs" aria-label="오늘 할 일 범위">
        <button class="todo-scope-button ${todoScope === 'personal' ? 'active' : ''}" type="button" data-todo-scope="personal">내 일정</button>
        <button class="todo-scope-button ${todoScope === 'team' ? 'active' : ''}" type="button" data-todo-scope="team">팀</button>
        <button class="todo-scope-button ${todoScope === 'all' ? 'active' : ''}" type="button" data-todo-scope="all">전체</button>
      </nav>
      <section class="todo-summary" aria-label="오늘 업무 요약">
        <article class="todo-summary-card primary"><span>오늘 할 일</span><strong>${items.length}건</strong></article>
        <article class="todo-summary-card"><span>완료</span><strong>${done}건</strong></article>
        <article class="todo-summary-card"><span>남은 업무</span><strong>${items.length - done}건</strong></article>
        <article class="todo-summary-card"><span>팀 업무</span><strong>${items.filter(event => event.scope === 'team').length}건</strong></article>
      </section>
      <section class="todo-board" aria-label="오늘의 업무 목록">
        <header class="todo-board-head"><div><strong>오늘의 업무</strong><span>파라곤 캘린더의 할 일 데이터를 표시합니다</span></div><div class="todo-board-progress">${items.length ? Math.round(done / items.length * 100) : 0}% 완료</div></header>
        ${groupMarkup || '<div class="live-list-empty">오늘 등록된 할 일이 없습니다.</div>'}
      </section>`;

    todoView.querySelectorAll('[data-todo-scope]').forEach(button => button.addEventListener('click', () => {
      todoScope = button.dataset.todoScope;
      renderTodo();
    }));
    todoView.querySelectorAll('.todo-group-head').forEach(button => button.addEventListener('click', () => button.closest('.todo-group').classList.toggle('collapsed')));
  }

  function renderProjects() {
    const counts = {
      all: liveProjects.length,
      review: liveProjects.filter(project => project.status === 'review').length,
      active: liveProjects.filter(project => project.status === 'active').length,
      planning: liveProjects.filter(project => project.status === 'planning').length,
      done: liveProjects.filter(project => project.status === 'done').length,
      hold: liveProjects.filter(project => project.status === 'hold').length
    };
    const filtered = liveProjects.filter(project => {
      return projectFilter === 'all' || project.status === projectFilter;
    });
    const cards = filtered.map(project => {
      const status = PROJECT_STATUS[project.status] || PROJECT_STATUS.active;
      const progress = projectProgress(project);
      const people = project.member_names || project.owner_name || `${project.member_count || 0}명`;
      return `<article class="review-project-card" data-project-id="${esc(project.id)}">
        <div class="review-card-head"><span class="review-card-status ${status[1]}">${status[0]}</span><span class="readonly-badge">조회</span></div>
        <h2 class="review-card-title">${esc(project.name || '프로젝트명 없음')}</h2>
        <p class="review-card-description">${esc(project.description || '등록된 설명이 없습니다.')}</p>
        <div class="review-card-progress"><div class="review-card-progress-label"><span>진행률</span><strong>${progress.percent}%</strong></div><div class="progress-track"><i style="width:${progress.percent}%"></i></div></div>
        <div class="review-card-meta"><span class="review-card-members">담당 ${esc(people)}</span><span>${esc(project.deadline || '마감일 없음')}</span></div>
        <div class="review-card-actions"><span class="review-card-count">업무 ${progress.done}/${progress.total}</span><button class="review-open-button" type="button">상세보기</button></div>
      </article>`;
    }).join('');

    reviewView.innerHTML = `
      <section class="review-summary" aria-label="프로젝트 요약">
        <article class="review-summary-card primary"><span>전체</span><strong>${counts.all}</strong></article>
        <article class="review-summary-card"><span>진행 중</span><strong>${counts.active}</strong></article>
        <article class="review-summary-card"><span>확인 대기</span><strong>${counts.review}</strong></article>
        <article class="review-summary-card"><span>완료</span><strong>${counts.done}</strong></article>
      </section>
      <section class="review-controls">
        <nav class="review-filter-tabs" aria-label="프로젝트 상태">
          ${[['all','전체'],['active','진행 중'],['review','확인 대기'],['planning','기획 중'],['done','완료'],['hold','보류']].map(([key, label]) => `<button class="review-filter ${projectFilter === key ? 'active' : ''}" type="button" data-project-filter="${key}">${label} ${counts[key]}</button>`).join('')}
        </nav>
        <span class="review-visible-count">${filtered.length}개 표시</span>
      </section>
      <section class="review-project-grid" aria-label="프로젝트 목록">${cards || '<div class="review-empty">조건에 맞는 프로젝트가 없습니다.</div>'}</section>`;

    reviewView.querySelectorAll('[data-project-filter]').forEach(button => button.addEventListener('click', () => {
      projectFilter = button.dataset.projectFilter;
      renderProjects();
    }));
    reviewView.querySelectorAll('[data-project-id]').forEach(card => card.addEventListener('click', () => openProjectDetail(card.dataset.projectId)));
  }

  async function openProjectDetail(projectId) {
    openDetailModal('프로젝트 불러오는 중…', '<div class="live-list-empty">상세 데이터를 조회하고 있습니다.</div>');
    try {
      const project = await readOnlyApi('/projects/' + encodeURIComponent(projectId));
      const status = PROJECT_STATUS[project.status] || PROJECT_STATUS.active;
      const tasks = Array.isArray(project.tasks) ? project.tasks : [];
      const updates = Array.isArray(project.updates) ? project.updates : [];
      const members = Array.isArray(project.members) ? project.members : [];
      const taskRows = tasks.map(task => {
        const assignees = Array.isArray(task.assignees) ? task.assignees : [];
        const completed = assignees.filter(item => item.completed).length;
        const assigneeLabel = assignees.map(item => item.name).filter(Boolean).join(', ') || task.assignee_name || '미지정';
        return `<div class="readonly-task-row"><span><strong>${esc(task.title)}</strong><small>${esc(assigneeLabel)}${task.due_date ? ` · ${esc(task.due_date)}` : ''}</small></span><span class="review-card-status ${task.status === 'done' ? 'done' : task.status === 'review' ? 'review' : 'active'}">${esc(TASK_STATUS[task.status] || task.status || '대기')}${assignees.length > 1 ? ` ${completed}/${assignees.length}` : ''}</span></div>`;
      }).join('');
      const updateRows = updates.slice(0, 10).map(update => `<div class="readonly-task-row"><span><strong>${esc(update.author_name || update.owner_name || '작성자')}</strong><small>${esc(update.content || update.text || '')}</small></span><span>${esc(formatDate(update.created_at, { month: 'numeric', day: 'numeric' }))}</span></div>`).join('');
      openDetailModal(project.name || '프로젝트 상세', `
        <div class="readonly-detail-meta"><span>${esc(status[0])}</span><span>담당 ${esc(project.owner_name || '미지정')}</span><span>참여 ${members.length}명</span>${project.deadline ? `<span>마감 ${esc(project.deadline)}</span>` : ''}</div>
        <p class="readonly-detail-copy">${esc(project.description || '등록된 프로젝트 설명이 없습니다.')}</p>
        <h3 class="readonly-section-title">업무 ${tasks.length}개</h3>
        ${taskRows || '<div class="live-list-empty">등록된 업무가 없습니다.</div>'}
        <h3 class="readonly-section-title">진행사항 ${updates.length}개</h3>
        ${updateRows || '<div class="live-list-empty">등록된 진행사항이 없습니다.</div>'}
        <span class="readonly-badge">읽기 전용</span>`);
    } catch (error) {
      openDetailModal('프로젝트 조회 실패', `<div class="live-list-empty">${esc(error.message)}</div>`);
    }
  }

  function roomPreview(room) {
    const sender = room.last_message_sender ? `${room.last_message_sender}: ` : '';
    return sender + (room.last_message_text || '최근 메시지가 없습니다.');
  }

  function renderChatFilters() {
    const nav = chatView.querySelector('.chat-filter-tabs');
    const groups = new Map();
    liveChatRooms.forEach(room => {
      const key = room.group_id ? String(room.group_id) : 'ungrouped';
      const label = room.group_name || '미분류';
      groups.set(key, { label, count: (groups.get(key)?.count || 0) + 1 });
    });
    nav.innerHTML = `<button class="chat-filter ${chatFilter === 'all' ? 'active' : ''}" type="button" data-chat-filter="all">전체 ${liveChatRooms.length}</button>` +
      [...groups.entries()].map(([key, group]) => `<button class="chat-filter ${chatFilter === key ? 'active' : ''}" type="button" data-chat-filter="${esc(key)}">${esc(group.label)} ${group.count}</button>`).join('');
    nav.querySelectorAll('[data-chat-filter]').forEach(button => button.addEventListener('click', () => {
      chatFilter = button.dataset.chatFilter;
      renderChatRoomList();
    }));
  }

  function renderChatRoomList() {
    const query = (document.getElementById('chatSearchInput')?.value || '').trim().toLowerCase();
    const rooms = liveChatRooms.filter(room => {
      const group = room.group_id ? String(room.group_id) : 'ungrouped';
      const matchesGroup = chatFilter === 'all' || group === chatFilter;
      const text = [room.name, room.last_message_sender, room.last_message_text, room.group_name].join(' ').toLowerCase();
      return matchesGroup && (!query || text.includes(query));
    });
    document.getElementById('chatSearchCount').textContent = `채팅방 ${rooms.length}개`;
    const list = document.getElementById('chatRoomList');
    list.innerHTML = rooms.length ? rooms.map(room => {
      const unread = Number(liveUnreadCounts[room.id] || 0);
      const isMeeting = String(room.name || '').includes('회의');
      return `<div class="chat-room-row" role="button" tabindex="0" data-room-id="${esc(room.id)}">
        <span class="chat-room-avatar ${isMeeting ? 'meeting' : ''}">${isMeeting ? '◫' : '◌'}</span>
        <span class="chat-room-main"><span class="chat-room-title-line"><span class="chat-room-title">${esc(room.name)}</span>${room.group_name ? `<span class="chat-badge report">${esc(room.group_name)}</span>` : ''}</span><span class="chat-room-preview">${esc(roomPreview(room))}</span></span>
        <span class="chat-room-side"><span class="chat-room-meta"><span class="chat-room-time">${esc(formatDate(room.last_message_at || room.created_at, { month: 'numeric', day: 'numeric' }))}</span>${unread ? `<span class="chat-unread">${unread}</span>` : `<span class="chat-room-members">${Number(room.member_count || 0)}명</span>`}</span><span class="chat-row-icon">›</span></span>
      </div>`;
    }).join('') : '<div class="chat-empty">검색 결과가 없습니다.</div>';
    list.querySelectorAll('[data-room-id]').forEach(row => {
      const open = () => openChatRoom(row.dataset.roomId);
      row.addEventListener('click', open);
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
      });
    });
  }

  function renderChat() {
    chatView.querySelector('.chat-page-toolbar').innerHTML = `<div class="chat-page-actions"><span class="todo-readonly-note">운영 채팅 · 읽기 전용</span></div>`;
    const bulkToolbar = chatView.querySelector('.chat-bulk-toolbar');
    if (bulkToolbar) bulkToolbar.hidden = true;
    const input = document.getElementById('chatSearchInput');
    input.value = '';
    input.addEventListener('input', renderChatRoomList);
    renderChatFilters();
    renderChatRoomList();
    const composer = document.getElementById('chatComposer');
    composer.addEventListener('submit', event => {
      event.preventDefault();
      showToast('읽기 전용 화면에서는 메시지를 보낼 수 없습니다.');
    });
    const messageInput = document.getElementById('chatMessageInput');
    messageInput.disabled = true;
    messageInput.placeholder = '읽기 전용 · 메시지 전송은 기존 파라곤에서 가능합니다';
    composer.querySelectorAll('button').forEach(button => button.disabled = true);
    document.getElementById('chatBackButton').addEventListener('click', closeChatRoom);
  }

  function structuredMessageLabel(text) {
    if (!text || !text.startsWith('[')) return '';
    if (text.startsWith('[MEETING_BRIEF]')) return '회의 카드가 업데이트되었습니다.';
    if (text.startsWith('[MEETING_ACTION_LINK]')) return '액션 아이템이 일정 또는 할 일로 연결되었습니다.';
    if (text.startsWith('[MEETING_ACTION]')) return '액션 아이템이 등록되었습니다.';
    if (text.startsWith('[EVENT_SHARE]')) return '일정을 공유했습니다.';
    if (text.startsWith('[NOTICE_SHARE]')) return '공지를 공유했습니다.';
    if (text.startsWith('[IDEA_SHARE]')) return '아이디어를 공유했습니다.';
    return '공유 메시지';
  }

  async function openChatRoom(roomId) {
    const room = liveChatRooms.find(item => String(item.id) === String(roomId));
    if (!room) return;
    selectedChatRoomId = roomId;
    document.getElementById('chatListPane').hidden = true;
    document.getElementById('chatRoomPane').hidden = false;
    chatView.classList.add('room-open');
    body.classList.add('chat-preview-room-open');
    document.getElementById('chatThreadTitle').textContent = room.name;
    document.getElementById('chatThreadMeta').textContent = `참여자 ${Number(room.member_count || 0)}명 · 읽기 전용`;
    const container = document.getElementById('chatThreadMessages');
    container.innerHTML = '<div class="live-list-empty">최근 메시지를 조회하고 있습니다.</div>';
    try {
      const messages = await readOnlyApi('/chat-rooms/' + encodeURIComponent(roomId) + '/messages');
      if (String(selectedChatRoomId) !== String(roomId)) return;
      container.innerHTML = Array.isArray(messages) && messages.length ? messages.map(message => {
        const systemLabel = structuredMessageLabel(message.text);
        if (systemLabel) return `<div class="chat-message-system">${esc(systemLabel)}</div>`;
        const mine = message.uid === currentUser.uid;
        const imageUrl = safeAssetUrl(message.image_url);
        const fileUrl = safeAssetUrl(message.file_url);
        return `<div class="chat-message ${mine ? 'mine' : ''}">
          ${mine ? '' : `<span class="chat-message-avatar">${esc((message.name || '?').slice(0, 1))}</span>`}
          <span class="chat-message-content">${mine ? '' : `<span class="chat-message-name">${esc(message.name || '사용자')}</span>`}<span class="chat-message-bubble">${esc(message.text || (imageUrl ? '사진' : message.file_name || '파일'))}</span>${imageUrl ? `<img class="chat-message-image" src="${imageUrl}" alt="첨부 이미지" loading="lazy">` : ''}${fileUrl ? `<a class="chat-file-link" href="${fileUrl}" target="_blank" rel="noopener noreferrer">첨부파일 · ${esc(message.file_name || '파일')}</a>` : ''}<span class="chat-message-time">${esc(formatDate(message.created_at, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span></span>
        </div>`;
      }).join('') : '<div class="live-list-empty">표시할 메시지가 없습니다.</div>';
      container.scrollTop = container.scrollHeight;
    } catch (error) {
      container.innerHTML = `<div class="live-list-empty">메시지 조회 실패: ${esc(error.message)}</div>`;
    }
  }

  function closeChatRoom() {
    selectedChatRoomId = null;
    document.getElementById('chatRoomPane').hidden = true;
    document.getElementById('chatListPane').hidden = false;
    chatView.classList.remove('room-open');
    body.classList.remove('chat-preview-room-open');
  }

  function moduleStatusbar(title, detail) {
    return `<div class="module-statusbar">
      <span><strong>${esc(title)}</strong><small>${esc(detail)}</small></span>
      <span class="module-plan-badge">MVP 기획 · 데이터 연결 전</span>
    </div>`;
  }

  function moduleCard({ icon, tone = '', title, description, chip = '연결 전', chipClass = '', footer = '자료 구조 확정 후 연결', action = '구조 보기' }) {
    return `<article class="module-card">
      <div class="module-card-top"><span class="module-card-icon ${esc(tone)}">${esc(icon)}</span><span class="module-chip ${esc(chipClass)}">${esc(chip)}</span></div>
      <h2>${esc(title)}</h2>
      <p>${esc(description)}</p>
      <div class="module-card-footer"><span>${esc(footer)}</span><button class="module-action" type="button" data-module-action="${esc(title)}">${esc(action)}</button></div>
    </article>`;
  }

  function renderReportChart(label) {
    return `<div class="report-kpis">
      <article class="report-kpi"><span>보고 매출</span><strong>—</strong><small>매출 데이터 연결 전</small></article>
      <article class="report-kpi"><span>보고서 수</span><strong>—</strong><small>보고서 DB 연결 전</small></article>
      <article class="report-kpi"><span>전기 대비</span><strong>—</strong><small>비교 기준 연결 전</small></article>
    </div>
    <div class="report-chart">
      <div class="report-chart-title"><strong>${esc(label)} 매출 추이</strong><span>현재 계정의 지사·팀·개인 권한 범위</span></div>
      <div class="report-chart-axis"><span>높음</span><span>중간</span><span>낮음</span><span>0</span></div>
      <div class="report-chart-canvas"></div>
      <div class="report-chart-labels"><span>1구간</span><span>2구간</span><span>3구간</span><span>4구간</span><span>5구간</span></div>
      <div class="report-empty-overlay"><strong>매출 데이터 연결 후 표시</strong>실제 보고서의 기간별 매출을 선 그래프와 핵심 지표로 보여줄 자리입니다.</div>
    </div>`;
  }

  function renderAttendanceReport() {
    return `<section class="module-section">
      <div class="module-section-head"><span><strong>출근보고서</strong><small>출근·퇴근 시간과 근무 기록을 확인합니다</small></span><span class="module-chip">근태 API 연결 전</span></div>
      <div class="module-section-body" style="padding:0">
        <table class="empty-table">
          <thead><tr><th>이름</th><th>소속</th><th>출근</th><th>퇴근</th><th>근무시간</th><th>상태</th></tr></thead>
          <tbody><tr><td class="empty-table-message" colspan="6">실제 출근 기록이 연결되면 계정 권한 범위에 맞춰 표시됩니다.</td></tr></tbody>
        </table>
      </div>
    </section>`;
  }

  function renderReportsModule() {
    const types = [
      ['attendance', '◷', '출근보고서', '출퇴근 및 근태'],
      ['daily', '▤', '일일보고서', '일별 매출 지표'],
      ['weekly', '▥', '주간보고서', '주간 매출 추이'],
      ['monthly', '◫', '월말보고서', '월간 실적 결산'],
      ['quarterly', '◇', '분기별보고서', '분기 성장 지표']
    ];
    const selected = types.find(([key]) => key === reportType) || types[0];
    const content = reportType === 'attendance'
      ? renderAttendanceReport()
      : `<section class="module-section">
          <div class="module-section-head"><span><strong>${esc(selected[2])}</strong><small>기간별 보고 매출을 그래프와 지표로 확인합니다</small></span><span class="module-chip">매출 DB 연결 전</span></div>
          <div class="module-section-body">${renderReportChart(selected[2])}</div>
        </section>`;
    moduleView.innerHTML = `
      ${moduleStatusbar('보고서 모듈', '출근 기록과 일일·주간·월말·분기별 매출 보고서를 한곳에서 관리합니다.')}
      <div class="report-layout">
        <nav class="report-type-list" aria-label="보고서 종류">
          ${types.map(([key, icon, label, detail]) => `<button class="report-type-button ${reportType === key ? 'active' : ''}" type="button" data-report-type="${key}"><span class="report-type-icon">${icon}</span><span class="report-type-copy"><strong>${label}</strong><small>${detail}</small></span><span class="report-type-chevron">›</span></button>`).join('')}
        </nav>
        ${content}
      </div>
      <div class="module-security"><span>▣</span><span><strong>보고서 권한 기준</strong><br>대표는 전체 지사, 팀장은 소속 부서 전체와 본인, 일반 구성원은 본인에게 허용된 보고서만 조회하는 구조로 연결합니다.</span></div>`;
  }

  function renderDocumentsModule() {
    moduleView.innerHTML = `
      ${moduleStatusbar('자료 모듈', '회사에서 반복 사용하는 제안서와 교육자료를 Google Drive 기반으로 정리합니다.')}
      <section class="module-grid">
        ${moduleCard({ icon: '◇', title: '협업제안서', description: '제휴·협업을 위한 회사 소개, 서비스 구성, 제안서 원본과 최신 버전을 관리합니다.', action: '폴더 보기' })}
        ${moduleCard({ icon: '▤', tone: 'green', title: '교육메뉴얼', description: '신규 입사자와 직무별 온보딩에 필요한 공통 교육 매뉴얼을 관리합니다.', action: '메뉴얼 보기' })}
        ${moduleCard({ icon: '▦', tone: 'orange', title: '상품별 교육자료', description: '상품별 소개, 영업 포인트, FAQ와 업데이트 이력을 한곳에서 확인합니다.', action: '상품 분류 보기' })}
      </section>
      <section class="module-section">
        <div class="module-section-head"><span><strong>Google Drive 연결 구조</strong><small>원본 파일은 Drive에 두고 PEAK OS에서는 권한과 최신본을 관리합니다</small></span><span class="module-chip">Drive 연결 전</span></div>
        <div class="module-section-body">
          <div class="integration-flow">
            <div class="integration-node"><span class="module-card-icon">▱</span><strong>Drive 원본 자료</strong><small>기존 폴더와 문서를 자료 유형별로 연결</small></div>
            <div class="integration-arrow">→</div>
            <div class="integration-node primary"><span class="module-card-icon">P</span><strong>PEAK OS 자료함</strong><small>검색·최신 버전·권한을 한 화면에서 제공</small></div>
            <div class="integration-arrow">→</div>
            <div class="integration-node"><span class="module-card-icon green">♙</span><strong>직급·팀별 노출</strong><small>지사, 팀, 직급과 개별 예외 권한 적용</small></div>
          </div>
        </div>
      </section>`;
  }

  function serviceCategoryLabel(category) {
    return {
      sales: '판매·제안',
      review: '리뷰',
      tool: '업무도구',
      intake: '접수',
      automation: '자동화',
      operations: '운영',
      settlement: '정산'
    }[category] || '기타';
  }

  function renderServicesModule() {
    const categories = [
      ['all', '전체'],
      ['sales', '판매·제안'],
      ['review', '리뷰'],
      ['tool', '업무도구'],
      ['intake', '접수'],
      ['automation', '자동화'],
      ['operations', '운영'],
      ['settlement', '정산']
    ];
    const visible = serviceCatalog.filter(service => serviceFilter === 'all' || service.category === serviceFilter);
    moduleView.innerHTML = `
      ${moduleStatusbar('피크마케팅 서비스', '회사 상품·서비스·운영 사이트를 카드 형태로 등록하고 한곳에서 관리합니다.')}
      <section class="module-section">
        <div class="service-toolbar">
          <nav class="service-filters" aria-label="서비스 분류">
            ${categories.map(([key, label]) => `<button class="service-filter ${serviceFilter === key ? 'active' : ''}" type="button" data-service-filter="${key}">${label}<span>${key === 'all' ? serviceCatalog.length : serviceCatalog.filter(item => item.category === key).length}</span></button>`).join('')}
          </nav>
          <button class="service-add-button" type="button" data-service-add>＋ 상품 등록</button>
        </div>
        <div class="service-grid" aria-label="피크마케팅 상품 및 서비스">
          ${visible.map(service => {
            const url = safeAssetUrl(service.url);
            return `<article class="service-card">
              <div class="service-card-top"><span class="service-card-icon">${esc(service.icon || '🔗')}</span><span class="module-chip">${esc(serviceCategoryLabel(service.category))}</span></div>
              <h2>${esc(service.name)}</h2>
              <p>${esc(service.description || '설명이 등록되지 않았습니다.')}</p>
              <div class="service-card-footer">
                <span>${url ? '링크 등록됨' : '링크 미등록'}</span>
                ${url ? `<a class="module-action" href="${url}" target="_blank" rel="noopener noreferrer">열기 ↗</a>` : '<button class="module-action" type="button" data-module-action="서비스 링크">링크 등록</button>'}
              </div>
            </article>`;
          }).join('') || '<div class="live-list-empty">이 분류에 등록된 상품이 없습니다.</div>'}
        </div>
      </section>
      <div class="module-security"><span>▣</span><span><strong>현재는 로컬 등록 시안입니다</strong><br>상품 등록 폼의 내용은 이 브라우저 화면에만 추가되고 새로고침하면 초기화됩니다. 실제 저장은 상품 DB와 권한 API를 만든 뒤 연결합니다.</span></div>`;

    moduleView.querySelectorAll('[data-service-filter]').forEach(button => button.addEventListener('click', () => {
      serviceFilter = button.dataset.serviceFilter;
      renderPlannedModule('services');
    }));
    moduleView.querySelector('[data-service-add]')?.addEventListener('click', openServiceDraftModal);
  }

  function openServiceDraftModal() {
    openDetailModal('상품 등록 · 로컬 시안', `
      <form class="service-form" id="serviceDraftForm">
        <div class="service-form-note">서버에는 저장되지 않으며 현재 화면에서만 카드가 추가됩니다.</div>
        <label><span>상품명 *</span><input name="name" maxlength="60" required placeholder="예: 신규 리워드 서비스"></label>
        <label><span>설명</span><textarea name="description" maxlength="180" rows="3" placeholder="상품 또는 서비스의 용도를 입력하세요"></textarea></label>
        <div class="service-form-row">
          <label><span>아이콘</span><input name="icon" maxlength="4" value="🔗" placeholder="🔗"></label>
          <label><span>분류</span><select name="category"><option value="sales">판매·제안</option><option value="review">리뷰</option><option value="tool">업무도구</option><option value="intake">접수</option><option value="automation">자동화</option><option value="operations">운영</option><option value="settlement">정산</option></select></label>
        </div>
        <label><span>연결 주소</span><input name="url" type="url" placeholder="https://"></label>
        <div class="service-form-actions"><button class="module-action" type="button" data-service-cancel>취소</button><button class="service-add-button" type="submit">상품 추가</button></div>
      </form>`);
    document.querySelector('[data-service-cancel]')?.addEventListener('click', closeDetailModal);
    document.getElementById('serviceDraftForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const name = String(form.get('name') || '').trim();
      const description = String(form.get('description') || '').trim();
      const icon = String(form.get('icon') || '').trim() || '🔗';
      const category = String(form.get('category') || 'sales');
      const url = String(form.get('url') || '').trim();
      if (!name) return;
      if (url && !/^https?:\/\//i.test(url)) {
        showToast('연결 주소는 http:// 또는 https://로 입력해 주세요.');
        return;
      }
      serviceCatalog = [
        { id: `local-service-${Date.now()}`, name, description, icon, category, url },
        ...serviceCatalog
      ];
      serviceFilter = 'all';
      closeDetailModal();
      renderPlannedModule('services');
      showToast(`${name} 상품을 로컬 시안에 추가했습니다. 서버에는 저장되지 않았습니다.`);
    });
  }

  function renderCompanyModule() {
    moduleView.innerHTML = `
      ${moduleStatusbar('회사 자료 모듈', '사업자등록증과 회사 공식 자료를 지사·법인 단위로 관리합니다.')}
      <section class="module-grid two">
        ${moduleCard({ icon: '▥', title: '사업자등록증', description: '본사와 지사별 사업자등록증 원본, 발급일, 사업자번호와 사용 범위를 관리합니다.', chip: '민감자료', chipClass: 'restricted', footer: '허용된 지사만 조회', action: '자료함 보기' })}
        ${moduleCard({ icon: '◇', tone: 'violet', title: '회사 자료', description: '회사소개서, 법인 기본자료, 계좌 사본과 계약에 필요한 공식 자료를 관리합니다.', chip: '권한 적용', chipClass: 'visible', footer: '직급·팀별 접근 제어', action: '분류 보기' })}
      </section>
      <section class="module-section">
        <div class="module-section-head"><span><strong>지사·법인별 자료 구조</strong><small>대표가 전체 범위를 관리하고 사용자에게 허용된 지사 자료만 노출합니다</small></span><button class="module-action" type="button" data-module-action="지사 분류">지사 분류</button></div>
        <div class="module-section-body"><div class="data-unavailable"><span class="data-unavailable-icon">◇</span><div><strong>회사 자료가 아직 연결되지 않았습니다</strong><p>사업자등록증과 회사 공식 자료를 전달받으면 지사·법인 단위 폴더와 열람 권한을 구성합니다.</p></div></div></div>
      </section>
      <div class="module-security"><span>▣</span><span><strong>민감자료 보호</strong><br>파일 주소를 직접 노출하지 않고 서버 권한 확인, 열람 기록, 다운로드 권한을 함께 적용합니다.</span></div>`;
  }

  function renderOrganizationModule() {
    const currentGroup = String(userDoc?.group_name || '').trim();
    const canManageOrganization = ['admin', 'manager'].includes(userDoc?.role);
    const currentClass = (...names) => names.some(name => currentGroup.includes(name)) ? 'current' : '';
    const currentBadge = (...names) => names.some(name => currentGroup.includes(name)) ? '<span class="org-current-badge">내 소속</span>' : '';
    moduleView.innerHTML = `
      ${moduleStatusbar('피크마케팅 조직도', '대표를 최상위 마스터로 두고 지사·상위 조직·기능팀·직급 순서로 구성합니다.')}
      <section class="module-grid" aria-label="조직 구성 요약">
        <article class="report-kpi"><span>상위 조직</span><strong>2</strong><small>경영지원 · 플랫폼운영</small></article>
        <article class="report-kpi"><span>기능 팀</span><strong>4</strong><small>개발 · 인사 · 세무/재무 · 영업</small></article>
        <article class="report-kpi"><span>등록 구성원</span><strong>—</strong><small>사용자 DB 연결 전</small></article>
      </section>
      <section class="module-section">
        <div class="module-section-head">
          <span><strong>전체 조직 구조</strong><small>현재 로그인 계정의 소속은 파란색으로 강조됩니다</small></span>
          <span style="display:flex;gap:7px;align-items:center">
            <button class="module-action" type="button" data-module-action="지사별 조직도">전체 지사⌄</button>
            ${canManageOrganization ? '<button class="module-action" type="button" data-open-permissions>권한 관리</button>' : ''}
          </span>
        </div>
        <div class="module-section-body">
          <div class="org-chart">
            <article class="org-master-node">
              <span class="org-node-icon">♛</span>
              <span class="org-node-copy"><strong>대표</strong><small>최종 마스터 · 모든 지사와 조직 관리</small></span>
              <span class="org-master-chip">MASTER</span>
            </article>
            <div class="org-vertical-line"></div>
            <div class="org-divisions">
              <article class="org-division ${currentClass('경영지원', '개발', '인사', '세무', '재무')}">
                <header class="org-division-head">
                  <span class="org-node-icon support">◆</span>
                  <span class="org-node-copy"><strong>경영지원팀</strong><small>회사 운영·개발·인사·재무 관리</small></span>
                  ${currentBadge('경영지원')}
                </header>
                <div class="org-subteams">
                  <div class="org-subteam ${currentClass('개발')}"><span>⌘</span><strong>개발팀</strong>${currentBadge('개발')}</div>
                  <div class="org-subteam ${currentClass('인사')}"><span>♙</span><strong>인사담당</strong>${currentBadge('인사')}</div>
                  <div class="org-subteam ${currentClass('세무', '재무')}"><span>▥</span><strong>세무 · 재무</strong>${currentBadge('세무', '재무')}</div>
                </div>
              </article>
              <article class="org-division ${currentClass('플랫폼운영', '영업')}">
                <header class="org-division-head">
                  <span class="org-node-icon sales">◈</span>
                  <span class="org-node-copy"><strong>플랫폼운영팀</strong><small>접수·영업 및 현장 운영</small></span>
                  ${currentBadge('플랫폼운영')}
                </header>
                <div class="org-subteams">
                  <div class="org-subteam ${currentClass('영업')}"><span>◎</span><strong>영업팀</strong>${currentBadge('영업')}</div>
                  <div class="org-subteam planned"><span>＋</span><strong>추가 기능팀</strong><small>향후 확장</small></div>
                </div>
              </article>
            </div>
          </div>
        </div>
      </section>
      <section class="module-section">
        <div class="module-section-head"><span><strong>구성원·직급·지사 배치</strong><small>Google 계정과 사용자 DB를 연결하면 실제 구성원 정보가 표시됩니다</small></span><span class="module-chip">조직 DB 연결 전</span></div>
        <div class="module-section-body" style="padding:0">
          <table class="empty-table"><thead><tr><th>구성원</th><th>직급</th><th>소속팀</th><th>지사</th><th>보고 대상</th><th>권한</th></tr></thead><tbody><tr><td class="empty-table-message" colspan="6">실제 사용자·지사·직급 정보가 연결되면 조직도와 함께 표시됩니다.</td></tr></tbody></table>
        </div>
      </section>
      <div class="module-security"><span>▣</span><span><strong>조직도와 권한은 분리해서 관리합니다</strong><br>조직도는 보고 체계와 소속을 보여주고, 급여·최종정산·세금 같은 민감자료는 별도 서버 권한으로 다시 확인합니다.</span></div>`;
  }

  function renderSettlementModule() {
    const management = ['admin', 'manager'].includes(userDoc?.role);
    const managementCards = management ? `
      ${moduleCard({ icon: '♙', tone: 'green', title: '영업자별 개인정산서', description: '소속 또는 허용된 영업자별 매출, 공제, 지급 예정액과 정산 상태를 확인합니다.', chip: '관리직 조회', chipClass: 'visible', footer: '소속·허용 지사 기준', action: '영업자 목록' })}
      ${moduleCard({ icon: '♛', tone: 'violet', title: '최종정산서', description: '전체 정산 검토가 끝난 뒤 확정된 최종 지급 내역과 승인 이력을 관리합니다.', chip: '관리직 전용', chipClass: 'restricted', footer: '대표·팀장만 표시', action: '정산 구조 보기' })}` : '';
    moduleView.innerHTML = `
      ${moduleStatusbar('정산 모듈', management ? '개인정산과 관리직용 최종정산 구조를 확인합니다.' : '로그인한 영업자의 개인정산 범위만 표시합니다.')}
      <section class="module-grid ${management ? '' : 'single'}">
        ${moduleCard({ icon: '◉', title: '내 개인정산서', description: '본인의 매출, 공제 항목, 지급 예정액과 월별 정산 이력을 확인합니다.', chip: '본인만', chipClass: 'visible', footer: '현재 로그인 계정 기준', action: '정산서 보기' })}
        ${managementCards}
      </section>
      <section class="module-section">
        <div class="module-section-head"><span><strong>정산 현황</strong><small>실제 매출·공제·지급 데이터가 연결되면 월별 상태를 표시합니다</small></span><span class="module-chip">정산 DB 연결 전</span></div>
        <div class="module-section-body"><div class="report-kpis"><article class="report-kpi"><span>정산 대상</span><strong>—</strong><small>데이터 연결 전</small></article><article class="report-kpi"><span>검토 중</span><strong>—</strong><small>데이터 연결 전</small></article><article class="report-kpi"><span>지급 확정</span><strong>—</strong><small>데이터 연결 전</small></article></div></div>
      </section>
      <div class="module-security"><span>▣</span><span><strong>현재 적용 권한: ${esc(roleLabel(userDoc?.role))}</strong><br>${management ? '영업자별 정산과 최종정산 메뉴가 표시됩니다.' : '본인의 개인정산서만 표시되며 관리직용 정산 기능은 메뉴와 API 모두 차단합니다.'}</span></div>`;
  }

  function renderTaxModule() {
    moduleView.innerHTML = `
      ${moduleStatusbar('세금관리 모듈', '거래처별 증빙과 세금계산서를 한 단위로 묶어 관리합니다.')}
      <section class="module-grid two">
        ${moduleCard({ icon: '▥', title: '거래처별 사업자등록증', description: '거래처 기본정보와 사업자등록증 원본, 변경 이력 및 유효 상태를 관리합니다.', chip: '민감자료', chipClass: 'restricted', footer: '세무·재무 권한 적용', action: '거래처 보기' })}
        ${moduleCard({ icon: '▤', tone: 'orange', title: '세금계산서', description: '거래처별 발행·수취 세금계산서와 정산 연결 상태를 월별로 확인합니다.', chip: '세무자료', chipClass: 'restricted', footer: '발행·수취 상태 관리', action: '월별 보기' })}
      </section>
      <section class="module-section">
        <div class="module-section-head"><span><strong>거래처 증빙 현황</strong><small>사업자등록증과 세금계산서를 거래처 기준으로 연결합니다</small></span><span class="module-chip">세금 데이터 연결 전</span></div>
        <div class="module-section-body" style="padding:0"><table class="empty-table"><thead><tr><th>거래처</th><th>사업자등록증</th><th>세금계산서</th><th>정산 연결</th><th>담당자</th></tr></thead><tbody><tr><td class="empty-table-message" colspan="5">거래처와 세금 자료가 연결되면 이곳에 표시됩니다.</td></tr></tbody></table></div>
      </section>`;
  }

  function renderPlatformModule() {
    moduleView.innerHTML = `
      ${moduleStatusbar('플랫폼 통합 모듈', '각 플랫폼 API를 연결해 정산 내역을 한 화면에서 비교·확인합니다.')}
      <section class="module-section">
        <div class="module-section-head"><span><strong>API 통합 정산 흐름</strong><small>플랫폼별 원본 내역을 표준 정산 항목으로 변환합니다</small></span><span class="module-chip">API 목록 확정 전</span></div>
        <div class="module-section-body">
          <div class="integration-flow">
            <div class="integration-node"><span class="module-card-icon">⌘</span><strong>플랫폼 API</strong><small>승인된 각 플랫폼의 매출·수수료·지급 내역 수집</small></div>
            <div class="integration-arrow">→</div>
            <div class="integration-node primary"><span class="module-card-icon">P</span><strong>통합 정산 엔진</strong><small>항목 표준화, 중복 확인, 정산 기간 매칭</small></div>
            <div class="integration-arrow">→</div>
            <div class="integration-node"><span class="module-card-icon green">▥</span><strong>통합 정산 화면</strong><small>플랫폼·영업자·지사별 정산 결과 비교</small></div>
          </div>
        </div>
      </section>
      <section class="module-grid two">
        ${moduleCard({ icon: '＋', title: '플랫폼 연결 관리', description: '연동할 플랫폼, API 인증 방식, 수집 주기와 담당자를 등록합니다.', footer: '연동 대상 전달 필요', action: '연결 구조 보기' })}
        ${moduleCard({ icon: '✓', tone: 'green', title: '정산 검증', description: '플랫폼 원본 합계와 내부 정산 합계를 비교해 차이를 검토합니다.', footer: '검증 규칙 확정 필요', action: '검증 항목 보기' })}
      </section>`;
  }

  function renderSaasModule() {
    moduleView.innerHTML = `
      ${moduleStatusbar('SaaS HUB', '회사에서 사용하는 모든 SaaS 사이트와 담당·권한 정보를 한곳에 취합합니다.')}
      <section class="module-section">
        <div class="module-section-head"><span><strong>SaaS 사이트 목록</strong><small>서비스 주소, 사용 목적, 담당팀과 계정 정책을 관리합니다</small></span><button class="module-action" type="button" data-module-action="SaaS 등록">＋ SaaS 등록</button></div>
        <div class="module-section-body" style="padding:0"><table class="empty-table"><thead><tr><th>서비스</th><th>사용 목적</th><th>담당팀</th><th>로그인 방식</th><th>계약·갱신</th><th>상태</th></tr></thead><tbody><tr><td class="empty-table-message" colspan="6">사용 중인 SaaS 목록을 전달받으면 이곳에 통합합니다.</td></tr></tbody></table></div>
      </section>
      <section class="module-grid">
        ${moduleCard({ icon: '◇', title: '마케팅·영업', description: '광고, 분석, CRM과 영업 운영에 사용하는 SaaS를 분류합니다.', action: '분류 보기' })}
        ${moduleCard({ icon: '▦', tone: 'green', title: '업무·협업', description: '메신저, 문서, 일정, 프로젝트와 협업 도구를 분류합니다.', action: '분류 보기' })}
        ${moduleCard({ icon: '▥', tone: 'orange', title: '재무·관리', description: '결제, 회계, 세금과 인사 관리에 사용하는 SaaS를 분류합니다.', action: '분류 보기' })}
      </section>
      <div class="module-security"><span>▣</span><span><strong>계정 비밀번호는 저장하지 않습니다</strong><br>SaaS Hub에는 사이트 주소와 담당·권한 정책만 관리하고, 인증정보는 SSO 또는 별도 비밀관리 시스템으로 연결합니다.</span></div>`;
  }

  function renderPlannedModule(view) {
    if (view === 'reports') renderReportsModule();
    if (view === 'documents') renderDocumentsModule();
    if (view === 'services') renderServicesModule();
    if (view === 'company') renderCompanyModule();
    if (view === 'organization') renderOrganizationModule();
    if (view === 'settlement') renderSettlementModule();
    if (view === 'tax') renderTaxModule();
    if (view === 'platform') renderPlatformModule();
    if (view === 'saas') renderSaasModule();

    moduleView.querySelectorAll('[data-report-type]').forEach(button => button.addEventListener('click', () => {
      reportType = button.dataset.reportType;
      renderPlannedModule('reports');
    }));
    moduleView.querySelector('[data-open-permissions]')?.addEventListener('click', () => activateView('permissions'));
    wireModuleActions();
  }

  function wireModuleActions() {
    moduleView.querySelectorAll('[data-module-action]').forEach(button => button.addEventListener('click', () => {
      showToast(`${button.dataset.moduleAction} 기능은 실제 자료·API 구조가 확정되면 연결합니다.`);
    }));
  }

  function setNavClusterClosed(cluster, closed) {
    if (!cluster) return;
    cluster.classList.toggle('closed', closed);
    const toggle = cluster.querySelector('.nav-cluster-toggle');
    const caret = cluster.querySelector('.nav-cluster-caret');
    if (toggle) toggle.setAttribute('aria-expanded', closed ? 'false' : 'true');
    if (caret) caret.textContent = closed ? '⌄' : '⌃';
  }

  function activateView(view) {
    if (view !== 'chat') closeChatRoom();
    const isPlannedModule = Object.prototype.hasOwnProperty.call(PLANNED_MODULES, view);
    if (isPlannedModule) renderPlannedModule(view);
    dashboardView.hidden = view !== 'dashboard';
    calendarView.hidden = view !== 'calendar';
    chatView.hidden = view !== 'chat';
    todoView.hidden = view !== 'todo';
    reviewView.hidden = view !== 'review';
    moduleView.hidden = !isPlannedModule;
    permissionsView.hidden = view !== 'permissions';
    const labels = { dashboard: 'PEAKMARKETING', calendar: 'CALENDAR', chat: 'CHAT', todo: 'TO DO LIST', review: 'PROJECTS', permissions: '조직 및 권한', ...PLANNED_MODULES };
    pageCrumb.textContent = labels[view] || 'PEAKMARKETING';
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
    const activeNav = document.querySelector(`.app-sidebar .nav-item[data-view="${view}"]`);
    if (activeNav) setNavClusterClosed(activeNav.closest('[data-nav-cluster]'), false);
    body.classList.remove('menu-open');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function wireNavigation() {
    document.querySelector('.mobile-menu').addEventListener('click', () => body.classList.add('menu-open'));
    document.querySelector('.mobile-overlay').addEventListener('click', () => body.classList.remove('menu-open'));
    document.querySelectorAll('.nav-item[data-view]').forEach(button => button.addEventListener('click', () => activateView(button.dataset.view)));
    document.querySelectorAll('.tree-item[data-view]').forEach(button => button.addEventListener('click', () => activateView(button.dataset.view)));
    document.querySelectorAll('.tree-trigger').forEach(button => button.addEventListener('click', () => button.closest('.tree-group').classList.toggle('closed')));
    document.querySelectorAll('[data-nav-cluster]').forEach(cluster => {
      cluster.querySelector('.nav-cluster-toggle')?.addEventListener('click', () => {
        setNavClusterClosed(cluster, !cluster.classList.contains('closed'));
      });
    });

    const search = document.getElementById('sidebarTabSearch');
    const submit = document.getElementById('sidebarTabSearchSubmit');
    const searchable = [...document.querySelectorAll('.nav-section .nav-item[data-tab-search]')];
    const navClusters = [...document.querySelectorAll('[data-nav-cluster]')];
    const filter = () => {
      const query = search.value.trim().toLowerCase().replace(/\s/g, '');
      let visible = 0;
      searchable.forEach(button => {
        const matches = !query || button.dataset.tabSearch.toLowerCase().replace(/\s/g, '').includes(query);
        button.hidden = !matches;
        if (matches) visible += 1;
      });
      navClusters.forEach(cluster => {
        const hasVisibleItem = [...cluster.querySelectorAll('.nav-item[data-tab-search]')].some(button => !button.hidden);
        cluster.hidden = !!query && !hasVisibleItem;
        cluster.classList.toggle('search-open', !!query && hasVisibleItem);
      });
      document.getElementById('tabSearchEmpty').hidden = visible !== 0;
      return searchable.filter(button => !button.hidden);
    };
    search.addEventListener('input', filter);
    const openFirst = () => {
      const first = filter()[0];
      if (!first) return showToast('일치하는 탭이 없습니다.');
      activateView(first.dataset.view);
      search.value = '';
      filter();
    };
    submit.addEventListener('click', openFirst);
    search.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); openFirst(); }
    });

    document.getElementById('calendarPrev').addEventListener('click', async () => {
      calendarMonth -= 1;
      if (calendarMonth === 0) { calendarMonth = 12; calendarYear -= 1; }
      calendarSelected = `${calendarYear}-${String(calendarMonth).padStart(2, '0')}-01`;
      await ensureCalendarYear();
    });
    document.getElementById('calendarNext').addEventListener('click', async () => {
      calendarMonth += 1;
      if (calendarMonth === 13) { calendarMonth = 1; calendarYear += 1; }
      calendarSelected = `${calendarYear}-${String(calendarMonth).padStart(2, '0')}-01`;
      await ensureCalendarYear();
    });
    document.querySelectorAll('.calendar-scope-button').forEach(button => button.addEventListener('click', () => {
      calendarScope = button.dataset.scope;
      document.querySelectorAll('.calendar-scope-button').forEach(item => item.classList.toggle('active', item === button));
      renderCalendar();
    }));

    document.querySelectorAll('.tab-button, .preview-action, .perm-chip, .check').forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        showToast('읽기 전용 화면입니다. 변경은 기존 파라곤에서 진행해 주세요.');
      });
    });
  }

  async function ensureCalendarYear() {
    if (eventLoadedYear !== calendarYear) {
      document.getElementById('homeCalendarGrid').innerHTML = '<div class="live-list-empty">일정을 조회하고 있습니다.</div>';
      try {
        await fetchEventsForYear(calendarYear);
        renderDashboard();
        renderTodo();
        updateNavigationBadges();
      } catch (error) {
        showToast(`일정 조회 실패: ${error.message}`);
      }
    }
    renderCalendar();
  }

  function renderAllLiveViews() {
    applyUserIdentity();
    const mapPanel = dashboardView.querySelector('.map-panel');
    if (mapPanel) {
      const subtitle = mapPanel.querySelector('.panel-subtitle');
      if (subtitle) subtitle.textContent = 'MVP 메뉴 구조 · 운영 DB 미연결 영역';
    }
    const permissionsHeading = permissionsView.querySelector('.permissions-heading');
    if (permissionsHeading && !permissionsView.querySelector('[data-permission-plan-note]')) {
      const note = document.createElement('div');
      note.className = 'data-unavailable';
      note.dataset.permissionPlanNote = 'true';
      note.style.marginBottom = '16px';
      note.innerHTML = '<span class="data-unavailable-icon">!</span><div><strong>아래 조직·권한표는 MVP 기획안입니다</strong><p>현재 파라곤 DB의 실제 권한 설정값은 아직 연결하지 않았으며, 이 화면에서 변경하거나 저장할 수 없습니다.</p></div>';
      permissionsView.insertBefore(note, permissionsHeading);
    }
    updateNavigationBadges();
    renderDashboard();
    renderCalendar();
    renderTodo();
    renderProjects();
    renderChat();
    activateView('dashboard');
  }

  async function handleSignedIn(user) {
    currentUser = user;
    const button = document.getElementById('googleSignIn');
    button.disabled = true;
    setAuthStatus('계정 권한과 운영 데이터를 확인하고 있습니다…');
    try {
      userDoc = await readOnlyApi('/users/me');
      if (userDoc.is_active === false) throw new Error('비활성화된 계정입니다. 관리자에게 문의해 주세요.');
      if (!userDoc.approved) throw new Error('아직 승인되지 않은 계정입니다.');
      await loadLiveData();
      renderAllLiveViews();
      document.getElementById('authGate').hidden = true;
      showToast('기존 파라곤 운영 데이터를 읽기 전용으로 불러왔습니다.');
    } catch (error) {
      button.disabled = false;
      if (error.status === 404) {
        setAuthStatus('기존 파라곤에 등록된 계정이 아닙니다. 먼저 운영 사이트에서 계정 승인을 받아 주세요.', true);
      } else {
        setAuthStatus(error.message || '운영 데이터를 불러오지 못했습니다.', true);
      }
    }
  }

  function initialize() {
    createAuthGate();
    createDetailModal();
    wireNavigation();
    if (!window.firebase) {
      setAuthStatus('로그인 모듈을 불러오지 못했습니다. 새로고침해 주세요.', true);
      return;
    }
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    auth.getRedirectResult().catch(error => setAuthStatus(`로그인 실패: ${error.message}`, true));
    auth.onAuthStateChanged(user => {
      if (!user) {
        currentUser = null;
        userDoc = null;
        document.getElementById('authGate').hidden = false;
        document.getElementById('googleSignIn').disabled = false;
        setAuthStatus('등록·수정·삭제는 이 화면에서 실행되지 않습니다.');
        return;
      }
      handleSignedIn(user);
    });
  }

  initialize();
})();
