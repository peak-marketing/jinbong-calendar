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
  const accountPreviewSlot = document.getElementById('accountPreviewSlot');
  const toast = document.querySelector('.toast');
  const OS_AUTH_SYNC_CHANNEL_NAME = 'peakos-os-auth-sync-v1';
  const OS_AUTH_SYNC_STORAGE_KEY = 'peakos-os-auth-sync-event-v1';
  const OS_AUTH_SYNC_MIN_INTERVAL_MS = 1500;
  let toastTimer = 0;

  let auth;
  let currentUser = null;
  let userDoc = null;
  let osAuthRequestInFlight = false;
  let osAuthVerifyInFlight = false;
  let osAuthResendTimer = 0;
  let osAuthResendUntil = 0;
  let osAuthMaskedEmail = '';
  let osAuthChallengeId = '';
  let osAuthExpiresInSeconds = 300;
  let osAuthSessionExpiryTimer = 0;
  let osAuthExpired = false;
  let osAuthHardNavigating = false;
  let osAuthForceAccountChooser = false;
  let osAuthSyncChannel = null;
  let osAuthSyncPromise = null;
  let osAuthSyncQueuedForce = false;
  let osAuthLastSyncAt = 0;
  let osAuthSessionCheckGeneration = 0;
  let osAuthAccessGeneration = 0;
  const osAuthSeenSignalIds = new Set();
  const osAuthTabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let signedInLoadPromise = null;
  let signedInLoadUid = '';
  let liveEvents = [];
  let liveChecklistSummary = {};
  let liveProjects = [];
  let liveChatRooms = [];
  let liveUnreadCounts = {};
  let eventLoadedYear = null;
  let calendarYear = new Date().getFullYear();
  let calendarMonth = new Date().getMonth() + 1;
  let calendarSelected = localDateKey(new Date());
  let calendarScope = 'all';
  let calendarIncompleteOnly = true;
  let todoScope = 'all';
  let projectFilter = 'all';
  let projectDetailTab = 'overview';
  let chatFilter = 'all';
  let selectedChatRoomId = null;
  let reportType = 'attendance';
  let salesSummary = { key: '', status: 'idle', data: null, error: '' };
  const salesSummaryCache = new Map();
  // 실제 로그인 계정. 미리보기로 다른 사람 화면을 볼 때 되돌릴 기준이 된다.
  let realUserDoc = null;
  let previewPersona = '';
  // 들어오자마자 캘린더가 뜨게 한다. 미완료 일을 잊지 않는 게 먼저다.
  let activeView = 'calendar';
  // 시트접수 건. 아직 운영 DB에 쓰지 않고 브라우저에만 남는 초안이다.
  let intakeDraft = [];
  let bankMatchReviewRows = [];
  let intakeForm = { a: '', b: '', c: '', unit: '', qty: '', sell: '', client: '', expectedPayer: '', date: '', memo: '', kind: 'normal', refOf: '' };
  let intakeFilter = { client: '', product: '', paid: '' };
  // 재무·정산 탭은 같은 조회 기간을 공유한다. 개인정산서에서 8월을 고른 뒤
  // 입금체크·통장·세금계산서로 이동해도 같은 기준으로 맞춰 볼 수 있다.
  const FINANCE_PERIOD_VIEWS = [
    'settlement', 'deposit-check', 'bank', 'invoice', 'credit', 'closing',
    'tax-advance', 'tax-correction', 'refund-history', 'refund-client',
    'refund-mistaken', 'refund-invoice', 'expense-ad', 'expense-supplies',
    'purchase-fixed', 'purchase-supplier'
  ];
  let financePeriodFilter = {
    mode: 'all',
    month: koreaDateKey(new Date()).slice(0, 7),
    from: '',
    to: ''
  };
  // 최종정산서는 담당자 정리용으로 따로 기간을 잡는다.
  let finalFilter = { from: '', to: '', manager: '' };
  // 접수 폼이 정산서/최종정산서 양쪽에 뜬다. 최종정산서에서 넣은 건은
  // 개인정산서에 올라가지 않는다.
  let intakeContext = 'settlement';
  // 접수 폼은 접어 두고 버튼을 눌러야 펼친다. 정산서를 볼 때 방해되지 않게.
  let intakeOpen = false;
  let intakeSelection = [];
  let orgBranchFilter = 'all';
  // 평소에는 갈래로 나뉜 조직도, 수정할 때만 세로로 나열한다
  let orgEditMode = false;
  let orgDirectory = { status: 'idle', accounts: [] };
  // 직급 수정은 아직 운영 DB에 쓰지 않는다. 브라우저에만 남는 초안이다.
  let orgRankDraft = {};
  let serviceFilter = 'all';
  let companyDocumentState = { uid: '', status: 'idle', documents: [], error: '' };
  let companyDocumentLoadGeneration = 0;
  let companyDocumentFolder = 'branches';
  let clientCompanyDocumentState = {
    uid: '', status: 'idle', documents: [], error: '', query: '', draftQuery: '',
    pagination: { page: 1, limit: 25, total: 0, totalPages: 0 }
  };
  let clientCompanyDocumentLoadGeneration = 0;
  let clientCompanyDocumentSearchTimer = 0;
  let companyDocumentPreviewGeneration = 0;
  let companyDocumentPreviewTrigger = null;
  let companyDocumentPreviewCleanup = null;
  // 통장 원장은 권한이 있는 사용자가 탭을 처음 열 때만 읽는다.
  // 계정 미리보기로 전환하면 메모리에서도 비워 민감한 재무자료가 남지 않게 한다.
  let bankData = emptyBankData();
  let bankLoadPromise = null;
  let bankLoadGeneration = 0;
  let bankSyncingAccountId = '';
  let bankSelectedAccountId = '';
  let bankPage = 1;
  let financeRequestState = {
    status: 'idle', requests: [], scope: 'mine', error: '', view: '', queryKey: '',
    pagination: { page: 1, limit: 50, total: 0, totalPages: 0 }
  };
  let financeRequestLoadGeneration = 0;
  let financeRequestForm = {};
  let purchaseLedgerPage = 1;
  let purchaseLedgerState = {
    accountId: '', status: 'idle', account: null, transactions: [], error: '',
    pagination: { page: 1, limit: 100, total: 0, totalPages: 0 }
  };
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
    reports: '보고서',
    documents: '문서',
    services: '서비스',
    company: '회사 자료',
    organization: '조직도',
    settlement: '개인 정산서',
    'final-settlement': '최종정산서',
    'final-execution-settlement': '최종실행정산서',
    'monthly-guarantee': '월보장 정산서',
    'monthly-manage': '월관리 정산서',
    'direct-execution': '직접실행 정산서',
    ideas: '아이디어',
    requests: '개발수정요청',
    'deposit-check': '입금체크',
    bank: '통장별 거래내역',
    receivable: '미수금 현황',
    invoice: '세금계산서 매출',
    'tax-advance': '세금계산서 선발행 요청',
    'tax-correction': '세금계산서 정정요청',
    'refund-history': '환불내역',
    'refund-client': '거래처환불',
    'refund-mistaken': '오입금환불',
    'refund-invoice': '환불 계산서 요청',
    'expense-ad': '광고비 요청',
    'expense-supplies': '비품 요청',
    'purchase-fixed': '고정비용통장 매입',
    'purchase-supplier': '공급처입금통장 매입',
    credit: '충전금',
    closing: '결산',
    namecard: '명함',
    tax: '세금',
    platform: '플랫폼',
    saas: 'SaaS 허브'
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

  // 최종정산서 '드롭다운 및 영업자 단가' 탭에서 옮긴 단가표.
  // [대분류, 중분류, 소분류, 회사원가, 영업자단가] — null은 상시변동(직접 입력)
  // 단가표는 서버가 들고 있다. 회사 원가는 지정된 인원에게만 내려온다.
  // 화면 파일에 박아 두면 로그인 없이도 읽히므로 여기에 값을 두지 않는다.
  let PRICE_TABLE = [];

  // 돈이 오가는 통장. 공급사 정산에서 어느 통장으로 보냈는지 남긴다.
  const BANK_ACCOUNTS = ['매출통장', '공급처통장', '고정비용통장', '리워드스페이스통장', '리뷰스페이스통장'];
  const BANK_DEFAULT = '공급처통장';

  // 최종정산서 '공급처명' 열에서 뽑은 목록. 실제 시트에 쓰인 이름 그대로다.
  const SUPPLIERS = ['HM이노', '기발한마케팅', '김지홍 ( 1 )', '리브리', '마케팅초이 (2)', '바보들이만든회사', '부스팅샾', '애드펌프', '에이치에스', '엠플리파이', '영업자', '올스비실계정', '외주(다빈)', '윙', '이스트나인', '인포플래닛', '키지애드 (50)', '파파컴퍼니', '플랜b', '피크마케팅', '하이프웍스', '헬로우드림'];

  // 중분류|소분류 -> 기본 공급처. 시트에서 가장 많이 쓰인 곳을 기본값으로 두되,
  // 같은 상품을 여러 공급처에서 받는 경우가 있어 접수할 때 바꿀 수 있다.
  const SUPPLIER_BY_PRODUCT = {
    'AI 파라곤|일반배포': '피크마케팅',
    'AI 파라곤|프리미엄 이미지 생성': '피크마케팅',
    'Alpha|트래픽': '엠플리파이',
    'Alpha +|BOOSTER': '파파컴퍼니',
    'Alpha +|영업자': '영업자',
    'Alpha +|히든': '파파컴퍼니',
    'BOOSTER|Alpha': '엠플리파이',
    'BOOSTER|히든': '파파컴퍼니',
    'BOOSTER Pro|리워드 파라곤': '에이치에스',
    'BOOSTER Pro|트래픽': '에이치에스',
    'HP|25.0': '하이프웍스',
    'P01|개별세팅옵션': '헬로우드림',
    'P01|사진 1장': '헬로우드림',
    'P01|사진 1장 247': '헬로우드림',
    'P01|사진 3장': '헬로우드림',
    'P01|사진 3장 247': '헬로우드림',
    'P01|유입형 사진 3장 247': '헬로우드림',
    'P02|일반~준최5 이미지 7장 700': '이스트나인',
    'P02|준최2~준최5 이미지 10장 1000': '이스트나인',
    'P02|준최2~준최5 이미지 5장 500': '이스트나인',
    'P02|준최2~준최5 이미지 7장 700': '이스트나인',
    'P0B|프리미엄 배포(원고 및 사진 지정)': '플랜b',
    'SA|페이백': '피크마케팅',
    'T맵|T맵리뷰': '헬로우드림',
    'T맵|개별옵션': '헬로우드림',
    '네이버 가구매|기자단': 'HM이노',
    '네이버 가구매|물품비': 'HM이노',
    '네이버 가구매|택배대행비': 'HM이노',
    '당근|단골맺기': '엠플리파이',
    '당근|단순배포': '엠플리파이',
    '당근|비즈후기': '엠플리파이',
    '당근|찜': '엠플리파이',
    '랭크업|트래픽': '에이치에스',
    '리뷰삭제|빠른삭제': '리브리',
    '리워드 파라곤|트래픽': '에이치에스',
    '맘카페|단순배포': '윙',
    '맘카페|댓글작업': '윙',
    '브랜드블로그|연장 스타터 입문형': '피크마케팅',
    '블로그|블로그': '플랜b',
    '블로그탭|월보장': '마케팅초이 (2)',
    '상세페이지|1000PX': '외주(다빈)',
    '샤오홍슈|스탠다드': '기발한마케팅',
    '샤오홍슈|프리미엄': '기발한마케팅',
    '스페이스|[올인원] 1장 일반': '피크마케팅',
    '스페이스|[올인원] 1장 프리미엄': '피크마케팅',
    '스페이스|[올인원] 3장 일반': '피크마케팅',
    '스페이스|[올인원] 3장 프리미엄': '피크마케팅',
    '스페이스|[올인원] 7장 일반': '피크마케팅',
    '스페이스|[올인원] 7장 프리미엄': '피크마케팅',
    '스페이스|[일반] 1장 일반': '피크마케팅',
    '스페이스|[일반] 3장 일반': '피크마케팅',
    '스페이스|[일반] 3장 프리미엄': '피크마케팅',
    '스페이스|[일반] 7장 일반': '피크마케팅',
    '올데이|리워드 파라곤': '엠플리파이',
    '올데이|트래픽': '엠플리파이',
    '올스비실계정|올스비실계정': '올스비실계정',
    '원고|개인대필': '영업자',
    '원고|대필프로그램': '피크마케팅',
    '원고|블로그대필프로그램': '피크마케팅',
    '원고|프리미엄원고대필': '키지애드 (50)',
    '유튜브상위노출|건바이': '윙',
    '카드결제|수수료 1.15%': '영업자',
    '카카오|카카오맵리뷰': '애드펌프',
    '카페|건바이': '키지애드 (50)',
    '캐치테이블|캐치테이블리뷰': '애드펌프',
    '쿠팡가구매2|기자단2': '바보들이만든회사',
    '쿠팡가구매2|물품비': '바보들이만든회사',
    '쿠팡가구매2|택배대행비2': '바보들이만든회사',
    '클립리뷰|10장 내 슬라이드형': '헬로우드림',
    '클립리뷰|25초내 영상형': '헬로우드림',
    '통합검색|건바이': '키지애드 (50)',
    '통합검색|월보장': '마케팅초이 (2)',
    '파라곤|트래픽': '에이치에스',
    '파라곤 (쇼핑)|트래픽': '인포플래닛',
    '프리저|Alpha': '엠플리파이',
    '프리저|올데이': '엠플리파이',
    '프리저|저장하기': '부스팅샾',
    '프리저|트래픽': '부스팅샾',
    '프리저 (쇼핑)|트래픽': '부스팅샾',
    '플레이스|월보장': '김지홍 ( 1 )',
    '피크마케팅 상품|DB 프로그램': '피크마케팅',
    '히든|트래픽': '파파컴퍼니',
  };
  // 최종정산서는 직급 기준이 아니라 지정된 사람만 본다.
  // 같은 팀장이라도 전현우는 보고 김지홍은 보지 못한다.
  // 대표 계정은 구글 표시이름이 '패션TV봉이'라 실명과 함께 넣어 둔다.
  const FINAL_SETTLEMENT_VIEWERS = ['김진봉', '패션TV봉이', '손명아', '김대호', '박종원', '전현우'];
  const FINAL_EXECUTION_SETTLEMENT_VIEWERS = ['패션TV봉이', '박종원', '김대호', '손명아'];

  // 운영 파라곤에 이미 있는 화면. 영업자들에게는 여기까지만 보인다.
  // PEAK OS로 새로 만든 화면은 아직 검토 중이라 지정 인원에게만 연다.
  const LIVE_PARAGON_VIEWS = ['dashboard', 'calendar', 'chat', 'todo', 'review', 'ideas', 'requests'];
  const SALES_OPERATION_VIEWS = ['settlement', 'deposit-check'];
  const SPECIAL_SETTLEMENT_OWNERS = ['김지홍', '박우진', '김대호'];

  function canSeePeakosTabs() {
    // 대표 계정은 미리보기 중에도 화면을 열 수 있어야 각자 정산서를 확인할 수 있다.
    if (previewPersona && canPreviewRealData()) return true;
    if (userDoc?.role === 'admin') return true;
    return FINAL_SETTLEMENT_VIEWERS.includes(String(userDoc?.name || '').trim());
  }

  function canSeeSalesOperations() {
    if (userDoc?.role === 'admin') return true;
    if (FINAL_SETTLEMENT_VIEWERS.includes(String(userDoc?.name || '').trim())) return true;
    if (SPECIAL_SETTLEMENT_OWNERS.includes(String(userDoc?.name || '').trim())) return true;
    if (String(userDoc?.group_type || '').trim() === 'sales') return true;
    return /영업|지사/.test(String(userDoc?.group_name || ''));
  }

  // 하위 영업자의 개인정산서를 열어볼 수 있는 사람.
  const TEAM_SETTLEMENT_VIEWERS = ['김진봉', '패션TV봉이', '김대호', '박종원'];
  // 계정 미리보기 UI와 다른 사람 접수 조회를 쓸 수 있는 실제 로그인 계정.
  // 직급이나 admin 역할로 넓히지 않고 이 세 계정으로만 고정한다.
  const ACCOUNT_PREVIEW_VIEWERS = ['패션TV봉이', '박종원', '김대호'];

  // 충전 요청 전체 검토자는 통장 잔액/민감 통장 권한과 같은 네 명으로
  // 고정한다. role=admin만으로 넓어지지 않으며 서버에서도 UID로 재검증한다.
  const CREDIT_REQUEST_REVIEWERS = ['패션TV봉이', '박종원', '김대호', '손명아'];
  const FINANCE_REQUEST_VIEWS = [
    'tax-advance', 'tax-correction', 'refund-history', 'refund-client',
    'refund-mistaken', 'refund-invoice', 'expense-ad', 'expense-supplies'
  ];
  const TAX_BANKING_PUBLIC_VIEWS = ['bank', 'invoice', ...FINANCE_REQUEST_VIEWS];
  const PURCHASE_TAX_VIEWS = ['purchase-fixed', 'purchase-supplier'];
  const FINANCE_REQUEST_CONFIG = {
    'tax-advance': {
      kind: 'TAX_ADVANCE', title: '세금계산서 선발행 요청', action: '선발행 요청 등록',
      description: '입금 전에 계산서를 먼저 발행해야 하는 신규·기존 거래처 요청을 등록합니다.',
      requiresBusiness: true, requiresEmail: true, requiresPayee: false
    },
    'tax-correction': {
      kind: 'TAX_CORRECTION', title: '세금계산서 정정요청', action: '정정요청 등록',
      description: '사업자·이메일·품목·금액 등 이미 발행된 계산서의 변경 요청을 등록합니다.',
      requiresBusiness: true, requiresEmail: true, requiresPayee: false
    },
    'refund-client': {
      kind: 'REFUND_CLIENT', title: '거래처환불', action: '거래처환불 요청',
      description: '거래처에 돌려줄 금액과 환불계좌, 사유와 증빙을 등록합니다.',
      requiresBusiness: false, requiresEmail: false, requiresPayee: true, refund: true
    },
    'refund-mistaken': {
      kind: 'REFUND_MISTAKEN', title: '오입금환불', action: '오입금환불 요청',
      description: '잘못 입금된 통장과 입금 시각을 확인할 수 있도록 정확한 사유와 증빙을 등록합니다.',
      requiresBusiness: false, requiresEmail: false, requiresPayee: true, refund: true
    },
    'expense-ad': {
      kind: 'EXPENSE_AD', title: '광고비 요청', action: '광고비 요청 등록',
      description: '커뮤니티·플랫폼 광고 충전금과 결제 증빙을 회사 비용으로 요청합니다.',
      requiresBusiness: false, requiresEmail: false, requiresPayee: true
    },
    'expense-supplies': {
      kind: 'EXPENSE_SUPPLIES', title: '비품 요청', action: '비품 요청 등록',
      description: '업무 비품과 복리후생 구매 목적·금액·구매처를 등록합니다.',
      requiresBusiness: false, requiresEmail: false, requiresPayee: false
    }
  };

  // 직급은 위에서 아래로 높은 순. 권한 관리는 부장 이상만 가능하다.
  const ORG_RANKS = ['대표', '이사', '부장', '실장', '팀장', '과장', '대리', '주임'];
  const ORG_RANK_MANAGE_FROM = ORG_RANKS.indexOf('부장');
  const ORG_RANK_UNSET = '미지정';

  // 2026-07-28 대표 확인 조직도. 8월 개편 예정이라 이 상수만 고치면 화면이 따라간다.
  // 계정이 아직 없는 구성원도 조직도에는 보여야 해서 이름 기준으로 적어 둔다.
  const ORG_STRUCTURE = [
    {
      id: 'hq',
      name: '본사',
      lead: { name: '김진봉', rank: '대표', master: true, detail: '최종 마스터 · 모든 지사와 조직 관리' },
      divisions: [
        {
          id: 'hq-support',
          name: '경영지원팀',
          icon: '◆',
          tone: 'support',
          detail: '회사 운영 · 개발 · 세무 관리',
          members: [
            { name: '김대호', rank: '부장' },
            { name: '전현우', rank: '팀장' }
          ],
          teams: [
            {
              id: 'hq-dev',
              name: '개발팀',
              icon: '⌘',
              members: [
                { name: '이종혁', rank: '대리' },
                { name: '김동우', rank: '주임' }
              ]
            },
            {
              id: 'hq-tax',
              name: '세무팀',
              icon: '▥',
              members: [{ name: '손명아', rank: '실장' }]
            }
          ]
        },
        {
          id: 'hq-platform',
          name: '플랫폼 영업팀',
          icon: '◈',
          tone: 'sales',
          detail: '접수 · 영업 및 현장 운영',
          members: [
            { name: '박종원', rank: '부장' },
            { name: '김지홍', rank: '팀장' },
            { name: '박우진', rank: '과장' },
            { name: '김주현', rank: '과장' },
            { name: '김용일', rank: '대리' },
            { name: '은시후', rank: '주임' }
          ],
          teams: []
        }
      ]
    },
    {
      id: 'daegu',
      name: '대구지사',
      lead: { name: '김진표', rank: '대표', detail: '대구지사 총괄' },
      divisions: [
        {
          id: 'daegu-main',
          name: '대구지사 영업팀',
          icon: '◈',
          tone: 'sales',
          detail: '지사 영업 및 현장 운영',
          members: [
            { name: '임규태', rank: '이사' },
            { name: '진영석', rank: '이사' },
            { name: '김승현', rank: '이사' },
            { name: '이종용', rank: '팀장' }
          ],
          teams: []
        }
      ]
    },
    {
      id: 'jeonju',
      name: '전주지사',
      lead: { name: '손지호', rank: '대표', detail: '전주지사 총괄' },
      divisions: []
    }
  ];

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

  function koreaDateKey(date) {
    const value = date instanceof Date ? date : new Date(date);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(value).reduce((result, part) => {
      if (part.type !== 'literal') result[part.type] = part.value;
      return result;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
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
    body.append(gate);
    if (isOsRoute()) renderOsGoogleGate({ checking: true });
    else renderLegacyGoogleGate();
  }

  function isOsRoute(pathname = window.location.pathname) {
    return /^\/os(?:\/|$)/.test(String(pathname || ''));
  }

  function isOsLoginRoute(pathname = window.location.pathname) {
    return /^\/os\/login\/?$/.test(String(pathname || ''));
  }

  function safeOsNext(rawValue = '') {
    const fallback = '/os/';
    if (!rawValue) return fallback;
    try {
      const target = new URL(String(rawValue), window.location.origin);
      if (target.origin !== window.location.origin) return fallback;
      if (!/^\/os(?:\/|$)/.test(target.pathname) || isOsLoginRoute(target.pathname)) return fallback;
      return target.pathname + target.search + target.hash;
    } catch (error) {
      return fallback;
    }
  }

  function osNextFromLocation() {
    return safeOsNext(new URLSearchParams(window.location.search).get('next') || '');
  }

  function osLoginUrlForCurrentPage(reason = '') {
    const currentPath = window.location.pathname + window.location.search + window.location.hash;
    const next = isOsLoginRoute() ? osNextFromLocation() : safeOsNext(currentPath);
    return `/os/login?next=${encodeURIComponent(next)}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`;
  }

  function osLoginReasonMessage() {
    return new URLSearchParams(window.location.search).get('reason') === 'session-expired'
      ? '추가 인증 시간이 만료되었습니다. 이메일 인증을 다시 진행해 주세요.'
      : '';
  }

  function moveToOsLogin() {
    if (isOsLoginRoute()) return;
    window.history.replaceState({ peakOsAuth: true }, '', osLoginUrlForCurrentPage());
  }

  function moveToOsDestination() {
    const next = osNextFromLocation();
    window.history.replaceState({ peakOsAuth: true }, '', next);
  }

  function clearOsAuthTimer() {
    if (osAuthResendTimer) window.clearInterval(osAuthResendTimer);
    osAuthResendTimer = 0;
    osAuthResendUntil = 0;
  }

  function clearOsSessionExpiryTimer() {
    if (osAuthSessionExpiryTimer) window.clearTimeout(osAuthSessionExpiryTimer);
    osAuthSessionExpiryTimer = 0;
  }

  function lockOsAfterSessionExpiry() {
    if (!isOsRoute() || !currentUser || osAuthHardNavigating) return;
    osAuthHardNavigating = true;
    clearOsSessionExpiryTimer();
    clearOsAuthTimer();
    osAuthSessionCheckGeneration += 1;
    osAuthAccessGeneration += 1;
    osAuthExpired = true;
    osAuthChallengeId = '';
    resetBankData({ clearOperation: true });
    bankMatchReviewRows = [];
    if (activeView === 'bank') moduleView.innerHTML = '';
    signedInLoadPromise = null;
    signedInLoadUid = '';
    // 사용 중 세션이 끊긴 경우는 overlay만 올리지 않는다.
    // 전체 document를 버려야 DOM과 JS heap에 남은 통장·정산 자료도 같이 사라진다.
    window.location.replace(osLoginUrlForCurrentPage('session-expired'));
  }

  function scheduleOsSessionExpiry(seconds) {
    clearOsSessionExpiryTimer();
    const ttl = Number(seconds);
    if (!Number.isFinite(ttl) || ttl <= 0) return;
    osAuthSessionExpiryTimer = window.setTimeout(
      () => lockOsAfterSessionExpiry(),
      Math.min(ttl * 1000, 2147483647)
    );
  }

  function broadcastOsAuthState(type) {
    if (!isOsRoute() || !['verified', 'logout'].includes(type)) return;
    // 탭 사이에는 세션·인증번호를 절대 전달하지 않는다. 이 값은 각 탭이
    // 서버 상태를 다시 조회하게 만드는 알림일 뿐이다.
    const signal = {
      type,
      source: osAuthTabId,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      at: Date.now()
    };
    try { osAuthSyncChannel?.postMessage(signal); } catch (_) {}
    try { window.localStorage.setItem(OS_AUTH_SYNC_STORAGE_KEY, JSON.stringify(signal)); } catch (_) {}
  }

  function validOsAuthSignal(value) {
    return value
      && value.source !== osAuthTabId
      && ['verified', 'logout'].includes(value.type)
      && typeof value.id === 'string'
      && value.id.length > 0
      && value.id.length <= 100
      && Number.isFinite(Number(value.at))
      && Math.abs(Date.now() - Number(value.at)) < 60_000;
  }

  async function revalidateOsAuthSession({ force = false, lockOnFailure = true } = {}) {
    if (!isOsRoute() || !currentUser || !userDoc || osAuthHardNavigating) return null;
    if (osAuthSyncPromise) {
      if (force) {
        // 쿠키 발급 직전 시작된 조회라면 그 결과를 폐기하고, 끝나는 즉시
        // 새 쿠키로 한 번 더 조회한다.
        osAuthSyncQueuedForce = true;
        osAuthSessionCheckGeneration += 1;
      }
      return osAuthSyncPromise;
    }
    const checkedAt = Date.now();
    if (!force && checkedAt - osAuthLastSyncAt < OS_AUTH_SYNC_MIN_INTERVAL_MS) {
      return null;
    }
    osAuthLastSyncAt = checkedAt;
    const expectedUid = currentUser.uid;
    const checkGeneration = ++osAuthSessionCheckGeneration;
    const syncPromise = (async () => {
      let session;
      try {
        session = await readOnlyApi('/os-auth/session');
      } catch (error) {
        if (error.status === 401
          && ['OS_AUTH_SESSION_REQUIRED', 'OS_AUTH_SESSION_INVALID'].includes(error.code)) {
          session = error.payload || { required: true, verified: false };
        } else {
          // 통신 장애를 로그아웃으로 오인하면 사용 중인 화면이 불필요하게 잠긴다.
          console.warn('PEAK OS 탭 인증 상태 재확인 실패:', error.message);
          return null;
        }
      }
      if (!currentUser
        || currentUser.uid !== expectedUid
        || osAuthHardNavigating
        || checkGeneration !== osAuthSessionCheckGeneration) return null;

      osAuthMaskedEmail = String(session?.user?.maskedEmail || session?.maskedEmail || osAuthMaskedEmail || '');
      const verified = session?.required === false || hasOsAuthSession(session);
      if (!verified) {
        clearOsSessionExpiryTimer();
        if (!osAuthExpired) osAuthAccessGeneration += 1;
        osAuthExpired = true;
        const gate = document.getElementById('authGate');
        if (lockOnFailure && gate?.hidden) {
          lockOsAfterSessionExpiry();
        } else {
          moveToOsLogin();
          // 이미 번호 입력 화면에 있다면 탭 복귀 때 입력값을 지우지 않는다.
          if (!gate?.querySelector('.os-auth-card')) {
            renderOsEmailGate({ message: osLoginReasonMessage() });
          }
        }
        return false;
      }

      if (osAuthExpired) osAuthAccessGeneration += 1;
      osAuthExpired = false;
      osAuthHardNavigating = false;
      if (session.required === true) scheduleOsSessionExpiry(session?.expiresInSeconds);
      else clearOsSessionExpiryTimer();
      const gate = document.getElementById('authGate');
      if (isOsLoginRoute()) moveToOsDestination();
      if (gate && !gate.hidden) {
        renderOsAuthSuccess();
        try {
          await finishSignedInApp();
        } catch (error) {
          if (!osAuthHardNavigating) {
            moveToOsLogin();
            renderOsEmailGate({ message: error.message || '인증 상태를 확인하지 못했습니다.', isError: true });
          }
          return false;
        }
        if (!osAuthExpired && currentUser?.uid === expectedUid) gate.hidden = true;
      }
      return true;
    })();
    osAuthSyncPromise = syncPromise;
    try {
      return await syncPromise;
    } finally {
      if (osAuthSyncPromise === syncPromise) {
        const rerun = osAuthSyncQueuedForce && !osAuthHardNavigating;
        osAuthSyncQueuedForce = false;
        osAuthSyncPromise = null;
        if (rerun) {
          Promise.resolve()
            .then(() => revalidateOsAuthSession({ force: true, lockOnFailure }))
            .catch(error => console.warn('PEAK OS 탭 인증 재조회 실패:', error.message));
        }
      }
    }
  }

  function handleOsAuthSignal(signal) {
    if (!validOsAuthSignal(signal)) return;
    if (osAuthSeenSignalIds.has(signal.id)) return;
    if (osAuthSeenSignalIds.size >= 100) osAuthSeenSignalIds.clear();
    osAuthSeenSignalIds.add(signal.id);
    revalidateOsAuthSession({ force: true, lockOnFailure: true })
      .catch(error => console.warn('PEAK OS 탭 인증 동기화 실패:', error.message));
  }

  function initializeOsAuthTabSync() {
    if (!isOsRoute()) return;
    if (typeof window.BroadcastChannel === 'function') {
      try {
        osAuthSyncChannel = new window.BroadcastChannel(OS_AUTH_SYNC_CHANNEL_NAME);
        osAuthSyncChannel.addEventListener('message', event => handleOsAuthSignal(event.data));
      } catch (_) {
        osAuthSyncChannel = null;
      }
    }
    window.addEventListener('storage', event => {
      if (event.key !== OS_AUTH_SYNC_STORAGE_KEY || !event.newValue) return;
      try { handleOsAuthSignal(JSON.parse(event.newValue)); } catch (_) {}
    });
    window.addEventListener('focus', () => {
      revalidateOsAuthSession({ force: true, lockOnFailure: true })
        .catch(error => console.warn('PEAK OS 포커스 인증 확인 실패:', error.message));
    });
    window.addEventListener('pageshow', () => {
      revalidateOsAuthSession({ lockOnFailure: true })
        .catch(error => console.warn('PEAK OS 페이지 복귀 인증 확인 실패:', error.message));
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        revalidateOsAuthSession({ lockOnFailure: true })
          .catch(error => console.warn('PEAK OS 탭 복귀 인증 확인 실패:', error.message));
      }
    });
  }

  function maskEmail(value) {
    const email = String(value || '').trim();
    const at = email.indexOf('@');
    if (at < 1) return email || '등록 이메일';
    const local = email.slice(0, at);
    const shown = local.slice(0, Math.min(3, Math.max(1, local.length - 1)));
    return `${shown}***${email.slice(at)}`;
  }

  function osIdentity() {
    const fallbackName = currentUser?.displayName || currentUser?.email || '';
    const identity = accountIdentity(userDoc, fallbackName);
    const email = osAuthMaskedEmail || maskEmail(userDoc?.email || currentUser?.email || '');
    return { ...identity, email, initial: identity.name.slice(0, 1) || 'P' };
  }

  function osAuthProgressMarkup(stage) {
    const googleDone = stage !== 'google' && stage !== 'checking';
    const otpDone = stage === 'success' || stage === 'access';
    const accessDone = stage === 'access';
    const row = (number, title, copy, state, status) => `
      <div class="os-auth-step ${state}">
        <div class="os-auth-step-icon">${state === 'done' ? '✓' : number}</div>
        <div class="os-auth-step-copy"><strong>${title}</strong><small>${copy}</small></div>
        <span class="os-auth-step-status">${status}</span>
      </div>`;
    return `
      <section class="os-auth-progress" aria-label="로그인 진행 단계">
        ${row(1, 'Google 계정 확인', '브라우저 로그인 상태 자동 확인', googleDone ? 'done' : 'active', googleDone ? '완료' : '확인 중')}
        ${row(2, 'PEAK OS 추가 인증', '등록 이메일의 6자리 번호 입력', otpDone ? 'done' : (googleDone ? 'active' : ''), otpDone ? '완료' : (googleDone ? '진행 중' : '다음'))}
        ${row(3, '소속·권한 확인', '본사·직급별 패널 자동 연결', accessDone ? 'done' : (stage === 'success' ? 'active' : ''), accessDone ? '완료' : (stage === 'success' ? '확인 중' : '다음'))}
      </section>`;
  }

  function osAuthShieldMarkup() {
    return `<div class="os-auth-shield" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 5.5 5.7v5.5c0 4.2 2.7 7.7 6.5 9.8 3.8-2.1 6.5-5.6 6.5-9.8V5.7L12 3Z"/><path d="m9.2 12 1.8 1.8 3.9-4"/></svg>
    </div>`;
  }

  function osAuthShell(cardMarkup, stage) {
    const gate = document.getElementById('authGate');
    if (!gate) return;
    gate.hidden = false;
    gate.classList.add('os-auth-mode');
    gate.innerHTML = `<main class="os-auth-shell">${osAuthProgressMarkup(stage)}${cardMarkup}</main>`;
  }

  function renderLegacyGoogleGate() {
    const gate = document.getElementById('authGate');
    if (!gate) return;
    gate.classList.remove('os-auth-mode');
    gate.innerHTML = `
      <div class="auth-card">
        <div class="auth-logo">P</div>
        <h1>PEAK OS</h1>
        <p>기존 파라곤 계정으로 로그인하면<br>허용된 운영 데이터를 읽기 전용으로 확인할 수 있습니다.</p>
        <button class="auth-google" id="googleSignIn" type="button">Google 계정으로 로그인</button>
        <div class="auth-status" id="authStatus">등록·수정·삭제는 이 화면에서 실행되지 않습니다.</div>
      </div>`;
    gate.querySelector('#googleSignIn')?.addEventListener('click', signInWithGoogle);
  }

  function renderOsGoogleGate({ checking = false } = {}) {
    clearOsAuthTimer();
    const choosingAnotherAccount = osAuthForceAccountChooser && !checking;
    const card = `
      <section class="os-auth-card" aria-label="Google 회사 계정 확인">
        <div class="os-auth-card-top">
          <div>
            <div class="os-auth-kicker">1단계 · Google 계정 확인</div>
            <h1>${checking ? '로그인 상태 확인 중' : (choosingAnotherAccount ? '다른 Google 계정 선택' : 'Google 계정 로그인')}</h1>
            <p>${choosingAnotherAccount
              ? '기존 계정 연결을 종료했습니다.<br>사용할 회사 계정을 선택해 주세요.'
              : 'PEAK OS에 등록된 회사 계정인지<br>먼저 확인합니다.'}</p>
          </div>
          ${osAuthShieldMarkup()}
        </div>
        <button class="os-auth-primary" id="googleSignIn" type="button" ${checking ? 'disabled' : ''}>
          ${checking
            ? '<span class="os-auth-spinner" aria-hidden="true"></span>자동 로그인 확인 중…'
            : (choosingAnotherAccount ? '다른 Google 계정 선택하기' : 'Google 회사 계정으로 로그인')}
        </button>
        <div class="os-auth-message" id="authStatus" role="status" aria-live="polite">${checking
          ? '기존 로그인 정보가 있으면 자동으로 다음 단계로 넘어갑니다.'
          : (choosingAnotherAccount
            ? '아래 버튼을 누르면 Google 계정 선택창이 열립니다.'
            : 'Google 로그인이 남아 있지 않아 계정 확인이 필요합니다.')}</div>
        <div class="os-auth-footer">등록된 회사 계정만 PEAK OS에 접속할 수 있습니다.</div>
      </section>`;
    osAuthShell(card, checking ? 'checking' : 'google');
    document.getElementById('googleSignIn')?.addEventListener('click', signInWithGoogle);
  }

  function renderOsEmailGate({ sent = false, message = '', isError = false } = {}) {
    const identity = osIdentity();
    const requestArea = sent ? `
      <div class="os-auth-field-label"><span>인증번호</span><small>6자리 숫자</small></div>
      <div class="os-auth-otp-row" id="osAuthOtpRow" role="group" aria-label="이메일 인증번호 6자리">
        ${[1, 2, 3, 4, 5, 6].map((number, index) => `<input class="os-auth-otp" inputmode="numeric" pattern="[0-9]*" maxlength="1" ${index === 0 ? 'autocomplete="one-time-code"' : 'autocomplete="off"'} aria-label="인증번호 ${number}번째 자리">`).join('')}
      </div>
      <div class="os-auth-code-meta">
        <span>${esc(identity.email)}로 보낸 번호를 ${Math.max(1, Math.ceil(osAuthExpiresInSeconds / 60))}분 안에 입력해 주세요.</span>
        <button id="emailOtpResend" class="os-auth-text-button" type="button" disabled>재전송 01:00</button>
      </div>
      <button class="os-auth-primary" id="emailOtpVerify" type="button" disabled>인증하고 PEAK OS 들어가기 <span aria-hidden="true">→</span></button>` : `
      <div class="os-auth-email-guide">
        <strong>등록 이메일로 인증번호를 보내드립니다</strong>
        <span>${esc(identity.email)}에서 6자리 번호를 확인해 주세요.</span>
      </div>
      <button class="os-auth-primary" id="emailOtpRequest" type="button">등록 이메일로 인증번호 받기</button>`;
    const card = `
      <section class="os-auth-card" aria-label="PEAK OS 이메일 추가 인증">
        <div class="os-auth-card-top">
          <div>
            <div class="os-auth-kicker">2단계 · 추가 인증</div>
            <h1>PEAK OS 인증</h1>
            <p>회사 정보를 보호하기 위해<br>등록 이메일을 한 번 더 확인합니다.</p>
          </div>
          ${osAuthShieldMarkup()}
        </div>
        <div class="os-auth-verified">
          <span aria-hidden="true">✓</span> Google 회사 계정 확인이 완료되었습니다
        </div>
        <div class="os-auth-identity">
          <div class="os-auth-avatar">${esc(identity.initial)}</div>
          <div class="os-auth-identity-copy">
            <div><strong>${esc(identity.name)} ${esc(identity.rank)}</strong><span>${esc(identity.affiliation)}</span></div>
            <small>${esc(identity.email)}</small>
          </div>
          <span class="os-auth-lock" aria-label="사내 등록 정보로 고정됨">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
          </span>
        </div>
        ${requestArea}
        <div class="os-auth-message ${isError ? 'error' : ''}" id="authStatus" role="status" aria-live="polite">${esc(message)}</div>
        <button class="os-auth-secondary" id="changeGoogleAccount" type="button">다른 Google 계정으로 로그인</button>
        <div class="os-auth-footer">이름·직급·소속과 인증 이메일은 사내 등록 정보입니다.</div>
      </section>`;
    osAuthShell(card, 'email');
    document.getElementById('emailOtpRequest')?.addEventListener('click', requestEmailOtp);
    document.getElementById('emailOtpResend')?.addEventListener('click', requestEmailOtp);
    document.getElementById('emailOtpVerify')?.addEventListener('click', verifyEmailOtp);
    document.getElementById('changeGoogleAccount')?.addEventListener('click', changeGoogleAccount);
    if (sent) {
      wireOtpInputs();
      const remaining = Math.max(0, Math.ceil((osAuthResendUntil - Date.now()) / 1000));
      startOsAuthResendTimer(remaining || 60);
      document.querySelector('.os-auth-otp')?.focus();
    }
  }

  function renderOsAuthSuccess() {
    clearOsAuthTimer();
    const identity = osIdentity();
    const card = `
      <section class="os-auth-card os-auth-success-card" aria-label="PEAK OS 인증 완료">
        <div class="os-auth-success-icon" aria-hidden="true">✓</div>
        <div class="os-auth-kicker">인증 완료</div>
        <h1>${esc(identity.name)} ${esc(identity.rank)}님,<br>환영합니다</h1>
        <p>${esc(identity.affiliation)} 권한을 확인하고 있습니다.<br>잠시 후 PEAK OS로 이동합니다.</p>
      </section>`;
    osAuthShell(card, 'success');
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
    modal.querySelector('#readonlyModalClose').addEventListener('click', () => closeDetailModal());
    // 입력 중인 창은 바깥을 눌러도 닫지 않는다. 실수로 내용이 날아간다.
    modal.addEventListener('click', event => {
      if (event.target === modal && modal.dataset.locked !== 'true') closeDetailModal();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !modal.hidden) closeDetailModal();
    });
  }

  function clearCompanyDocumentPreview() {
    companyDocumentPreviewGeneration += 1;
    const trigger = companyDocumentPreviewTrigger;
    const cleanup = companyDocumentPreviewCleanup;
    companyDocumentPreviewTrigger = null;
    companyDocumentPreviewCleanup = null;
    if (trigger?.isConnected) trigger.disabled = false;
    cleanup?.();
    return trigger;
  }

  function openDetailModal(title, content, { locked = false } = {}) {
    clearCompanyDocumentPreview();
    const modal = document.getElementById('readonlyDetailModal');
    document.getElementById('readonlyModalTitle').textContent = title;
    document.getElementById('readonlyModalBody').innerHTML = content;
    modal.dataset.locked = locked ? 'true' : 'false';
    modal.hidden = false;
    body.style.overflow = 'hidden';
  }

  function closeDetailModal({ restoreFocus = true } = {}) {
    const trigger = clearCompanyDocumentPreview();
    const modal = document.getElementById('readonlyDetailModal');
    modal.dataset.locked = 'false';
    modal.hidden = true;
    body.style.overflow = '';
    if (restoreFocus && trigger?.isConnected) {
      window.requestAnimationFrame(() => trigger.focus());
    }
  }

  function setAuthStatus(message, isError = false) {
    const status = document.getElementById('authStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('error', isError);
  }

  function updateOtpVerifyState() {
    const inputs = [...document.querySelectorAll('.os-auth-otp')];
    const button = document.getElementById('emailOtpVerify');
    if (!button) return;
    button.disabled = osAuthVerifyInFlight || inputs.length !== 6 || inputs.some(input => !/^\d$/.test(input.value));
  }

  function fillOtpInputs(inputs, digits) {
    String(digits || '').replace(/\D/g, '').slice(0, 6).split('').forEach((digit, index) => {
      if (inputs[index]) inputs[index].value = digit;
    });
    const nextIndex = Math.min(String(digits || '').replace(/\D/g, '').length, 5);
    inputs[nextIndex]?.focus();
    updateOtpVerifyState();
  }

  function wireOtpInputs() {
    const inputs = [...document.querySelectorAll('.os-auth-otp')];
    inputs.forEach((input, index) => {
      input.addEventListener('input', () => {
        const digits = input.value.replace(/\D/g, '');
        if (digits.length > 1) {
          inputs.forEach(field => { field.value = ''; });
          fillOtpInputs(inputs, digits);
          return;
        }
        input.value = digits.slice(-1);
        input.removeAttribute('aria-invalid');
        if (input.value) inputs[index + 1]?.focus();
        updateOtpVerifyState();
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Backspace' && !input.value) inputs[index - 1]?.focus();
        if (event.key === 'ArrowLeft') inputs[index - 1]?.focus();
        if (event.key === 'ArrowRight') inputs[index + 1]?.focus();
        if (event.key === 'Enter' && !document.getElementById('emailOtpVerify')?.disabled) verifyEmailOtp();
      });
      input.addEventListener('paste', event => {
        const digits = event.clipboardData?.getData('text').replace(/\D/g, '').slice(0, 6) || '';
        if (!digits) return;
        event.preventDefault();
        inputs.forEach(field => { field.value = ''; });
        fillOtpInputs(inputs, digits);
      });
    });
    updateOtpVerifyState();
  }

  function startOsAuthResendTimer(seconds = 60) {
    if (osAuthResendTimer) window.clearInterval(osAuthResendTimer);
    const safeSeconds = Math.max(0, Math.min(600, Number(seconds) || 0));
    osAuthResendUntil = Date.now() + safeSeconds * 1000;
    const tick = () => {
      const button = document.getElementById('emailOtpResend');
      if (!button) {
        clearOsAuthTimer();
        return;
      }
      const remaining = Math.max(0, Math.ceil((osAuthResendUntil - Date.now()) / 1000));
      const minutes = Math.floor(remaining / 60);
      const secs = String(remaining % 60).padStart(2, '0');
      button.textContent = remaining ? `재전송 ${String(minutes).padStart(2, '0')}:${secs}` : '인증번호 다시 받기';
      button.disabled = osAuthRequestInFlight || remaining > 0;
      if (!remaining && osAuthResendTimer) {
        window.clearInterval(osAuthResendTimer);
        osAuthResendTimer = 0;
      }
    };
    tick();
    if (safeSeconds > 0) osAuthResendTimer = window.setInterval(tick, 1000);
  }

  async function requestEmailOtp() {
    if (osAuthRequestInFlight) return;
    const button = document.getElementById('emailOtpRequest') || document.getElementById('emailOtpResend');
    osAuthRequestInFlight = true;
    if (button) button.disabled = true;
    setAuthStatus('등록 이메일로 인증번호를 보내고 있습니다…');
    try {
      const result = await callApi('POST', '/os-auth/email/request', {});
      if (result?.ok === false) throw new Error(result.error || '인증번호를 보내지 못했습니다.');
      osAuthMaskedEmail = String(result?.maskedEmail || result?.emailMasked || result?.destination || osAuthMaskedEmail || '');
      osAuthChallengeId = String(result?.challengeId || '');
      osAuthExpiresInSeconds = Math.max(60, Number(result?.expiresInSeconds) || 300);
      const retryAfter = Number(result?.retryAfter ?? result?.retryAfterSeconds ?? result?.resendAfter ?? 60);
      osAuthResendUntil = Date.now() + Math.max(0, retryAfter) * 1000;
      renderOsEmailGate({ sent: true, message: '인증번호를 보냈습니다. 이메일을 확인해 주세요.' });
    } catch (error) {
      setAuthStatus(error.message || '인증번호를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.', true);
      if (button) button.disabled = false;
    } finally {
      osAuthRequestInFlight = false;
      const remaining = Math.max(0, Math.ceil((osAuthResendUntil - Date.now()) / 1000));
      if (document.getElementById('emailOtpResend')) startOsAuthResendTimer(remaining);
    }
  }

  async function verifyEmailOtp() {
    if (osAuthVerifyInFlight) return;
    const inputs = [...document.querySelectorAll('.os-auth-otp')];
    const code = inputs.map(input => input.value).join('');
    if (!/^\d{6}$/.test(code)) {
      setAuthStatus('이메일에서 확인한 6자리 숫자를 모두 입력해 주세요.', true);
      inputs.find(input => !input.value)?.focus();
      return;
    }
    osAuthVerifyInFlight = true;
    inputs.forEach(input => { input.disabled = true; });
    updateOtpVerifyState();
    setAuthStatus('인증번호와 소속 권한을 확인하고 있습니다…');
    try {
      const result = await callApi('POST', '/os-auth/email/verify', { code, challengeId: osAuthChallengeId });
      if (result?.ok === false || result?.verified === false || result?.authenticated === false) {
        throw new Error(result?.error || '인증번호가 올바르지 않거나 만료되었습니다.');
      }
      osAuthSessionCheckGeneration += 1;
      if (osAuthExpired) osAuthAccessGeneration += 1;
      osAuthExpired = false;
      scheduleOsSessionExpiry(result?.expiresInSeconds);
      broadcastOsAuthState('verified');
      renderOsAuthSuccess();
      moveToOsDestination();
      try {
        // 백그라운드 탭에서는 setTimeout이 지연될 수 있으므로 인증 직후 바로
        // 운영 데이터를 연다. 다른 탭도 위 신호를 받은 뒤 서버에서 재검증한다.
        await finishSignedInApp();
      } catch (error) {
        if (osAuthHardNavigating) return;
        moveToOsLogin();
        renderOsEmailGate({ sent: true, message: error.message || '운영 데이터를 불러오지 못했습니다.', isError: true });
      }
    } catch (error) {
      inputs.forEach(input => {
        input.disabled = false;
        input.setAttribute('aria-invalid', 'true');
      });
      setAuthStatus(error.message || '인증번호를 확인하지 못했습니다.', true);
      inputs[0]?.focus();
    } finally {
      osAuthVerifyInFlight = false;
      updateOtpVerifyState();
    }
  }

  async function endOsSession() {
    clearOsSessionExpiryTimer();
    if (!currentUser || !isOsRoute()) return;
    try {
      await callApi('POST', '/os-auth/logout', {});
      broadcastOsAuthState('logout');
    } catch (error) {
      console.warn('PEAK OS 추가 인증 세션 종료 실패:', error.message);
    }
  }

  async function changeGoogleAccount() {
    const button = document.getElementById('changeGoogleAccount');
    if (button) button.disabled = true;
    clearOsAuthTimer();
    setAuthStatus('현재 PEAK OS 인증을 종료하고 Google 계정 선택 화면을 준비하고 있습니다…');
    try {
      await endOsSession();
      osAuthForceAccountChooser = true;
      await auth.signOut();
      renderOsGoogleGate();
    } catch (error) {
      osAuthForceAccountChooser = false;
      if (currentUser) {
        renderOsEmailGate({ message: `계정 전환을 준비하지 못했습니다: ${error.message}`, isError: true });
      } else {
        renderOsGoogleGate();
        setAuthStatus(`계정 전환을 준비하지 못했습니다: ${error.message}`, true);
      }
    }
  }

  function hasOsAuthSession(payload) {
    return payload?.authenticated === true
      || payload?.verified === true
      || payload?.active === true
      || payload?.session?.authenticated === true
      || payload?.session?.verified === true
      || payload?.session?.active === true;
  }

  async function signInWithGoogle() {
    const button = document.getElementById('googleSignIn');
    if (button) button.disabled = true;
    setAuthStatus('Google 로그인을 여는 중입니다…');
    const provider = new firebase.auth.GoogleAuthProvider();
    const choosingAnotherAccount = osAuthForceAccountChooser;
    if (choosingAnotherAccount) provider.setCustomParameters?.({ prompt: 'select_account' });
    try {
      await auth.signInWithPopup(provider);
    } catch (error) {
      if (button) button.disabled = false;
      if (error.code === 'auth/popup-blocked' && !choosingAnotherAccount) {
        try {
          await auth.signInWithRedirect(provider);
        } catch (redirectError) {
          setAuthStatus(`로그인 화면을 열지 못했습니다: ${redirectError.message}`, true);
        }
        return;
      }
      if (error.code === 'auth/popup-blocked') {
        setAuthStatus('브라우저에서 팝업을 허용한 뒤 다시 눌러 주세요.', true);
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
    return callApi('GET', path);
  }

  // 정산 데이터만 서버에 쓴다. 그 밖의 운영 데이터는 여전히 읽기만 한다.
  const WRITABLE_PREFIX = '/peakos/';
  const WRITABLE_OS_AUTH_PATHS = new Set([
    '/os-auth/email/request',
    '/os-auth/email/verify',
    '/os-auth/logout'
  ]);

  async function callApi(method, path, body) {
    if (!currentUser) throw new Error('로그인이 필요합니다.');
    const requestUser = currentUser;
    const requestUid = requestUser.uid;
    const staleAuthContextError = () => {
      const error = new Error('로그인 계정이 변경되어 이전 요청 결과를 폐기했습니다.');
      error.code = 'AUTH_CONTEXT_CHANGED';
      return error;
    };
    if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('잘못된 조회 경로입니다.');
    if (method !== 'GET' && !path.startsWith(WRITABLE_PREFIX) && !WRITABLE_OS_AUTH_PATHS.has(path)) {
      throw new Error('이 경로에는 쓸 수 없습니다.');
    }
    const token = await requestUser.getIdToken();
    if (!currentUser || currentUser.uid !== requestUid) throw staleAuthContextError();
    const response = await fetch('/api' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      credentials: 'same-origin'
    });
    const payload = await response.json().catch(() => ({}));
    // 다른 Google 계정으로 바뀐 뒤 도착한 응답은 전역 화면 데이터에 절대
    // 반영하지 않는다. 특히 이전 계정의 늦은 401이 새 계정을 잠그면 안 된다.
    if (!currentUser || currentUser.uid !== requestUid) throw staleAuthContextError();
    if (!response.ok) {
      const error = new Error(payload.error || `조회 실패 (${response.status})`);
      error.status = response.status;
      error.code = payload.code || '';
      error.required = payload.required;
      error.verified = payload.verified;
      error.payload = payload;
      if (response.status === 401
        && path.startsWith('/peakos/')
        && ['OS_AUTH_SESSION_REQUIRED', 'OS_AUTH_SESSION_INVALID'].includes(error.code)) {
        lockOsAfterSessionExpiry();
      }
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
      projectId: record.project_id ?? record.projectId ?? '',
      sortOrder: Number(record.sort_order ?? record.sortOrder ?? 0)
    };
  }

  async function fetchEventsForYear(year) {
    const data = await readOnlyApi(`/events?from=${year}-01-01&to=${year}-12-31`);
    liveEvents = Array.isArray(data) ? data.map(normalizeEvent) : [];
    eventLoadedYear = year;
  }

  async function loadLiveData() {
    const currentYear = new Date().getFullYear();
    const [events, checklistSummary, rooms, unread, projectData] = await Promise.all([
      readOnlyApi(`/events?from=${currentYear}-01-01&to=${currentYear}-12-31`),
      readOnlyApi('/events/checklist-summary').catch(() => ({})),
      readOnlyApi('/chat-rooms'),
      readOnlyApi('/chat-rooms/unread').catch(() => ({})),
      readOnlyApi('/projects')
    ]);
    liveEvents = Array.isArray(events) ? events.map(normalizeEvent) : [];
    liveChecklistSummary = checklistSummary && typeof checklistSummary === 'object' ? checklistSummary : {};
    eventLoadedYear = currentYear;
    liveChatRooms = Array.isArray(rooms) ? rooms : [];
    liveUnreadCounts = unread && typeof unread === 'object' ? unread : {};
    liveProjects = Array.isArray(projectData) ? projectData : (projectData.projects || []);
  }

  function roleLabel(role) {
    return { admin: '관리자', manager: '팀장', member: '멤버' }[role] || '멤버';
  }

  function accountIdentity(doc, fallbackName = '') {
    const name = String(doc?.name || fallbackName || '').trim() || '사용자';
    const row = orgRoster().find(item => String(item.name || '').trim() === name);
    const rank = row ? orgRankOf(row) : roleLabel(doc?.role);
    const affiliation = String(row?.branch?.name || doc?.group_name || '').trim() || '소속 미지정';
    return { name, rank, affiliation, label: [name, rank, affiliation].join(' · ') };
  }

  function applyUserIdentity() {
    const member = document.querySelector('.app-sidebar > .member');
    const name = userDoc.name || currentUser.displayName || currentUser.email || '사용자';
    const identity = accountIdentity(userDoc, name);
    const realIdentity = accountIdentity(realUserDoc, name);
    const initials = name.slice(-2);
    member.innerHTML = `
      <div class="avatar">${esc(initials)}</div>
      <div class="member-copy"><strong>${esc(identity.name)}</strong><small>${esc(identity.rank)} · ${esc(identity.affiliation)}</small></div>
      <button class="member-signout" id="memberSignout" type="button" title="로그아웃" aria-label="로그아웃">↪</button>`;
    member.querySelector('#memberSignout').addEventListener('click', async () => {
      await endOsSession();
      await auth.signOut();
      location.reload();
    });
    const showPersonaControl = canPreviewPersona();
    accountPreviewSlot.hidden = !showPersonaControl;
    accountPreviewSlot.innerHTML = showPersonaControl ? `
      ${previewPersona ? `<span class="persona-preview-warning" role="status" title="${esc(identity.label)} 계정 미리보기 중">
        ${canPreviewRealData() ? '미리보기 중 · 저장 안 됨' : '미리보기 중 · 데이터 비공개'}
      </span>` : ''}
      <label class="persona-switch">
        <span class="persona-switch-label">계정 미리보기</span>
        <select id="personaSelect">
          <option value="">내 계정 (${esc(realIdentity.label)})</option>
          ${orgRoster().filter(row => String(row.name || '').trim() !== String(realUserDoc?.name || '').trim()).map(row => `<option value="${esc(row.name)}" ${previewPersona === row.name ? 'selected' : ''}>${esc(row.name)} · ${esc(orgRankOf(row))} · ${esc(row.branch.name)}</option>`).join('')}
        </select>
      </label>` : '';
    accountPreviewSlot.querySelector('#personaSelect')?.addEventListener('change', event => applyPersona(event.target.value));
    applyNavPermissions();
  }

  // 최종정산서 탭은 지정된 인원에게만 보인다.
  function applyNavPermissions() {
    const peakosOpen = canSeePeakosTabs();
    const salesOperationsOpen = canSeeSalesOperations();
    const locks = {
      settlement: salesOperationsOpen,
      'deposit-check': salesOperationsOpen,
      'final-settlement': peakosOpen && canSeeFinalSettlement(),
      'final-execution-settlement': canSeeFinalExecutionSettlement(),
      'monthly-guarantee': canSeeMonthly('monthly-guarantee'),
      'monthly-manage': canSeeMonthly('monthly-manage'),
      'direct-execution': canSeeMonthly('direct-execution'),
      // 영업자는 여기서 리뷰/리워드 충전 요청을 올리고, 지정 재무 담당자만
      // 전체 요청과 기존 충전금 장부를 본다.
      credit: !previewPersona,
      closing: peakosOpen && canSeeFinalSettlement(),
      bank: canSeeBankLedger(),
      receivable: peakosOpen && canSeeTeamSettlement()
    };
    TAX_BANKING_PUBLIC_VIEWS.forEach(view => {
      locks[view] = canSeeTaxBankingView(view);
    });
    PURCHASE_TAX_VIEWS.forEach(view => {
      locks[view] = canSeeTaxPurchase();
    });
    // 미리보기 중에는 채팅을 닫는다. 실제로는 로그인한 본인의 대화가 뜨는데
    // 남의 계정 화면처럼 보이면 오해를 부르고, 대화 내용은 미리 볼 것이 아니다.
    // 항상 값을 넣어야 미리보기에서 돌아왔을 때 다시 켜진다.
    locks.chat = !previewPersona;
    // 나머지 신규 화면은 지정 인원에게만 통째로 연다.
    document.querySelectorAll('.app-sidebar .nav-item[data-view]').forEach(button => {
      const view = button.dataset.view;
      if (locks[view] !== undefined || LIVE_PARAGON_VIEWS.includes(view) || view === 'permissions') return;
      locks[view] = peakosOpen;
    });
    Object.entries(locks).forEach(([view, allowed]) => {
      const button = document.querySelector(`.app-sidebar .nav-item[data-view="${view}"]`);
      if (!button) return;
      button.dataset.navLocked = allowed ? 'false' : 'true';
      button.hidden = !allowed;
    });
    document.querySelectorAll('[data-nav-subcluster]').forEach(subcluster => {
      const items = [...subcluster.querySelectorAll('.nav-item[data-view]')];
      const hidden = items.length > 0 && items.every(item => item.hidden);
      subcluster.hidden = hidden;
      subcluster.dataset.navLocked = hidden ? 'true' : 'false';
    });
    // 안에 보일 항목이 하나도 없는 묶음은 통째로 감춘다.
    document.querySelectorAll('[data-nav-cluster]').forEach(cluster => {
      const items = [...cluster.querySelectorAll('.nav-item[data-view]')];
      cluster.hidden = items.length > 0 && items.every(item => item.hidden);
    });
  }

  // 다른 사람 화면이 어떻게 보이는지 확인하는 용도. 화면 표시만 바뀌고
  // 서버에서 내려오는 데이터는 실제 로그인 계정 것 그대로다.
  function applyPersona(name) {
    // 숨겨진 DOM 조작으로 호출돼도 허용된 실제 계정이 아니면 미리보기를 만들지 않는다.
    const requestedName = canPreviewPersona() ? String(name || '').trim() : '';
    const realName = String(realUserDoc?.name || '').trim();
    // 내 조직도 행을 강제로 선택해도 별도 미리보기 계정으로 만들지 않는다.
    previewPersona = requestedName && requestedName !== realName ? requestedName : '';
    if (!previewPersona) {
      userDoc = realUserDoc;
    } else {
      const row = orgRoster().find(item => item.name === previewPersona);
      const rank = row ? orgRankOf(row) : ORG_RANK_UNSET;
      userDoc = {
        ...realUserDoc,
        name: previewPersona,
        role: rank === '대표' ? 'admin' : (rank === '주임' ? 'member' : 'manager'),
        group_name: row ? (row.teamName || row.divisionName) : '',
        group_type: row && /영업|지사/.test(String(row.teamName || row.divisionName || '')) ? 'sales' : 'support'
      };
    }
    // 통장 원장은 계정 미리보기에서 절대 이어 보이지 않는다.
    // 진행 중인 조회 결과도 세대 번호로 폐기하고 다른 화면으로 즉시 이동한다.
    if (previewPersona) {
      resetBankData({ clearOperation: true });
      financeRequestState = {
        status: 'idle', requests: [], scope: 'mine', error: '', view: '', queryKey: '',
        pagination: { page: 1, limit: 50, total: 0, totalPages: 0 }
      };
      financeRequestLoadGeneration += 1;
      purchaseLedgerPage = 1;
      purchaseLedgerState = {
        accountId: '', status: 'idle', account: null, transactions: [], error: '',
        pagination: { page: 1, limit: 100, total: 0, totalPages: 0 }
      };
      if (TAX_BANKING_PUBLIC_VIEWS.includes(activeView) || PURCHASE_TAX_VIEWS.includes(activeView)) {
        activateView('calendar');
      }
    }
    loadPeakosData().then(() => {
      applyUserIdentity();
      const lost = (activeView === 'final-settlement' && !canSeeFinalSettlement())
        || (activeView === 'final-execution-settlement' && !canSeeFinalExecutionSettlement())
        || (Boolean(MONTHLY_TABS[activeView]) && !canSeeMonthly(activeView))
        || (activeView === 'credit' && Boolean(previewPersona))
        || (activeView === 'closing' && !canSeeFinalSettlement())
        || (activeView === 'bank' && !canSeeBankLedger())
        || ((TAX_BANKING_PUBLIC_VIEWS.includes(activeView) || PURCHASE_TAX_VIEWS.includes(activeView))
          && !canSeeTaxBankingView(activeView))
        || (activeView === 'receivable' && !canSeeTeamSettlement());
      activateView(lost ? 'settlement' : activeView);
    });
  }

  // 계정이 바뀌면 그 계정 기준으로 다시 읽는다.
  async function loadPeakosData() {
    await Promise.all([
      loadIntakeDraft(),
      loadBankMatchReviewRows(),
      loadCustomPrices(),
      loadMonthlyDraft(),
      loadFinalExecutionSettlement(),
      loadCreditDraft(),
      loadFundBoard(),
      loadIdeaData(),
    ]);
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

  function isReportCalendarEvent(event) {
    return event.todoCat === '보고서' || /보고서|업무보고/.test(event.title || '');
  }

  function calendarAgendaEvent(event) {
    const checklist = liveChecklistSummary[String(event.id)] || { completed: 0, total: 0 };
    const checklistLabel = checklist.total ? `체크리스트 ${checklist.completed}/${checklist.total}` : '';
    return `<button class="agenda-work-item ${event.done ? 'done' : ''}" type="button" data-event-detail="${esc(event.id)}">
      <span class="agenda-work-check">${event.done ? '✓' : ''}</span>
      <span class="agenda-work-copy">
        <strong>${esc(event.title)}</strong>
        <small>${esc(event.ownerName || '담당자 미지정')}${event.time ? ` · ${esc(formatTime(event.time))}` : ''}</small>
        ${event.memo ? `<em>${esc(event.memo)}</em>` : ''}
      </span>
      ${checklistLabel ? `<span class="agenda-work-checklist">${esc(checklistLabel)}</span>` : ''}
    </button>`;
  }

  function renderCalendarAgenda() {
    const agenda = document.getElementById('homeCalendarAgenda');
    const allSelectedEvents = liveEvents.filter(event => event.date === calendarSelected);
    const selectedEvents = calendarEventsForScope()
      .filter(event => event.date === calendarSelected)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, 'ko'));
    const selectedDate = new Date(calendarSelected + 'T00:00:00');
    const selectedDateLabel = formatDate(selectedDate, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
    const compactDate = `${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')} (${weekdays[selectedDate.getDay()]})`;
    const personalCount = allSelectedEvents.filter(event => event.scope !== 'team').length;
    const teamCount = allSelectedEvents.filter(event => event.scope === 'team').length;
    const incompleteCount = allSelectedEvents.filter(event => !event.done).length;
    const meetingCount = allSelectedEvents.filter(event => event.type === 'meeting').length;
    const relatedProjectIds = new Set(allSelectedEvents.map(event => String(event.projectId || '')).filter(Boolean));
    const relatedRoomCount = new Set(liveProjects
      .filter(project => relatedProjectIds.has(String(project.id)))
      .map(project => project.chat_room_id)
      .filter(Boolean)).size;
    const reportEvents = selectedEvents.filter(isReportCalendarEvent);
    const visibleEvents = calendarIncompleteOnly ? selectedEvents.filter(event => !event.done) : selectedEvents;
    const grouped = new Map();
    visibleEvents.forEach(event => {
      const category = event.todoCat || (event.type === 'meeting' ? '미팅' : event.type === 'todo' ? '기타 업무' : '일정');
      if (!grouped.has(category)) grouped.set(category, []);
      grouped.get(category).push(event);
    });
    const groupRows = [...grouped.entries()].map(([category, events], index) => {
      const allInCategory = selectedEvents.filter(event => (event.todoCat || (event.type === 'meeting' ? '미팅' : event.type === 'todo' ? '기타 업무' : '일정')) === category);
      const completed = allInCategory.filter(event => event.done).length;
      const tones = ['coral', 'violet', 'teal', 'blue'];
      return `<section class="agenda-work-group" data-agenda-group>
        <button class="agenda-work-group-head" type="button">
          <span class="agenda-work-caret">▼</span><i class="${tones[index % tones.length]}"></i><strong>${esc(category)}</strong><small>${completed}/${allInCategory.length}</small>
        </button>
        <div class="agenda-work-group-body">${events.map(calendarAgendaEvent).join('')}</div>
      </section>`;
    }).join('');
    const listTitle = calendarScope === 'personal' ? '내 일정' : calendarScope === 'team' ? '팀 일정' : '전체 일정';
    agenda.innerHTML = `
      <div class="agenda-scope-tabs" aria-label="일정 범위">
        <button class="${calendarScope === 'personal' ? 'active' : ''}" type="button" data-agenda-scope="personal">내 일정</button>
        <button class="${calendarScope === 'team' ? 'active' : ''}" type="button" data-agenda-scope="team">팀</button>
        <button class="${calendarScope === 'all' ? 'active' : ''}" type="button" data-agenda-scope="all">전체</button>
      </div>
      <div class="agenda-filter-row"><button class="${calendarIncompleteOnly ? 'active' : ''}" type="button" data-agenda-incomplete>✓ 미완료만</button></div>
      <section class="agenda-day-summary">
        <div class="agenda-date"><span>${esc(selectedDateLabel)}</span><strong>${esc(compactDate)}</strong></div>
        <p>전체 ${allSelectedEvents.length}건 · 관련 채팅방 ${relatedRoomCount}개</p>
        <div class="agenda-day-stats">
          <span><strong>${personalCount}</strong><small>내 일정</small></span>
          <span><strong>${teamCount}</strong><small>팀 일정</small></span>
          <span><strong>${incompleteCount}</strong><small>미완료</small></span>
          <span><strong>${meetingCount}</strong><small>미팅</small></span>
        </div>
      </section>
      <section class="agenda-report-section">
        <header><strong>▤ 보고서 현황</strong><span>${reportEvents.filter(event => event.done).length}/${reportEvents.length}</span></header>
        <div>${reportEvents.length ? reportEvents.map(event => `<button type="button" data-event-detail="${esc(event.id)}"><span>${event.done ? '✓' : '▶'}</span><strong>${esc(event.title)}</strong></button>`).join('') : '<p>이 날짜의 보고서 일정이 없습니다.</p>'}</div>
      </section>
      <section class="agenda-work-section">
        <header><strong>▣ ${esc(listTitle)}</strong><span>${visibleEvents.length}건</span></header>
        <div class="agenda-work-groups">${groupRows || `<div class="agenda-work-empty">${selectedEvents.length && calendarIncompleteOnly ? '미완료 일정이 없습니다.' : '이 날짜에 일정이 없습니다.'}</div>`}</div>
      </section>
      <span class="todo-readonly-note">운영 데이터 · 읽기 전용</span>`;
    agenda.querySelectorAll('[data-agenda-scope]').forEach(button => button.addEventListener('click', () => {
      calendarScope = button.dataset.agendaScope;
      document.querySelectorAll('.calendar-scope-button').forEach(item => item.classList.toggle('active', item.dataset.scope === calendarScope));
      renderCalendar();
    }));
    agenda.querySelector('[data-agenda-incomplete]').addEventListener('click', () => {
      calendarIncompleteOnly = !calendarIncompleteOnly;
      renderCalendarAgenda();
    });
    agenda.querySelectorAll('[data-agenda-group]').forEach(group => group.querySelector('.agenda-work-group-head').addEventListener('click', () => group.classList.toggle('closed')));
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
      const eventMarkup = dateEvents.slice(0, 3).map(event => `<span class="calendar-event ${esc(event.type)}"><i></i><span>${esc(event.title)}</span></span>`).join('');
      cells.push(`
        <button class="home-calendar-cell ${dateEvents.length ? 'has-events' : ''} ${key === localDateKey(new Date()) ? 'today' : ''} ${key === calendarSelected ? 'selected' : ''} ${weekday === 0 ? 'sun' : ''} ${weekday === 6 ? 'sat' : ''}" type="button" data-date="${key}">
          <span class="calendar-date-line"><span class="calendar-date">${day}</span>${dateEvents.length ? `<span class="calendar-count">${dateEvents.length}</span>` : ''}</span>
          <span class="calendar-events">${eventMarkup}</span>${dateEvents.length > 3 ? `<span class="calendar-more">+${dateEvents.length - 3}개 더보기</span>` : ''}
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
    // 미완료를 먼저 보여 준다. 다 끝낸 일이 위에 있으면 놓치기 쉽다.
    items = [...items].sort((a, b) => Number(Boolean(a.done)) - Number(Boolean(b.done)));
    const grouped = new Map();
    items.forEach(event => {
      const key = event.todoCat || (event.scope === 'team' ? '팀 업무' : `${event.ownerName || '내'} 업무`);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(event);
    });
    const groupMarkup = [...grouped.entries()]
      .sort((x, y) => y[1].filter(e => !e.done).length - x[1].filter(e => !e.done).length)
      .map(([name, events]) => {
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
        <article class="todo-summary-card primary"><span>남은 업무</span><strong>${items.length - done}건</strong></article>
        <article class="todo-summary-card"><span>오늘 할 일</span><strong>${items.length}건</strong></article>
        <article class="todo-summary-card"><span>완료</span><strong>${done}건</strong></article>
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

  function projectTaskRow(task) {
    const assignees = Array.isArray(task.assignees) ? task.assignees : [];
    const completed = assignees.filter(item => item.completed).length;
    const assigneeLabel = assignees.map(item => item.name).filter(Boolean).join(', ') || task.assignee_name || '미지정';
    const taskStatus = task.status || 'todo';
    const statusClass = taskStatus === 'done' ? 'done' : taskStatus === 'review' ? 'review' : taskStatus === 'hold' ? 'hold' : 'active';
    const completion = assignees.length > 1 ? ` ${completed}/${assignees.length}` : '';
    return `<article class="project-detail-task">
      <button class="project-detail-check ${taskStatus === 'done' ? 'checked' : ''}" type="button" disabled aria-label="${esc(task.title)} 완료 상태">${taskStatus === 'done' ? '✓' : ''}</button>
      <div class="project-detail-task-copy">
        <div class="project-detail-task-meta"><span class="review-card-status ${statusClass}">${esc(TASK_STATUS[taskStatus] || taskStatus)}${completion}</span><span>담당 ${esc(assigneeLabel)}</span>${task.due_date ? `<span>마감 ${esc(task.due_date)}</span>` : ''}</div>
        <strong>${esc(task.title || '업무명 없음')}</strong>
        ${task.description ? `<p>${esc(task.description)}</p>` : ''}
      </div>
      <button class="project-detail-text-action" type="button" data-project-readonly-action>수정</button>
    </article>`;
  }

  function projectUpdateRow(update) {
    const author = update.author_name || update.owner_name || '작성자';
    return `<article class="project-detail-update">
      <span class="project-detail-avatar">${esc(author.slice(0, 1))}</span>
      <div><div class="project-detail-update-meta"><strong>${esc(author)}</strong><span>${esc(formatDate(update.created_at, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span>${update.status_snapshot ? `<span class="review-card-status active">${esc(update.status_snapshot)}</span>` : ''}</div><p>${esc(update.content || update.text || '')}</p></div>
    </article>`;
  }

  function projectEventRow(event) {
    return `<article class="project-detail-event">
      <span class="project-detail-event-date"><strong>${esc(formatDate(event.date, { month: 'numeric', day: 'numeric' }))}</strong><small>${esc(formatTime(event.time || ''))}</small></span>
      <span><strong>${esc(event.title || '프로젝트 일정')}</strong><small>${esc(event.memo || event.description || '등록된 일정 설명이 없습니다.')}</small></span>
    </article>`;
  }

  function projectCommentRow(comment) {
    const author = comment.author_name || '작성자';
    let attachments = comment.attachments;
    if (typeof attachments === 'string') {
      try { attachments = JSON.parse(attachments); } catch (_) { attachments = []; }
    }
    if (!Array.isArray(attachments)) attachments = [];
    const attachmentRows = attachments.map(attachment => {
      const url = safeAssetUrl(attachment.url || attachment.download_url || attachment.src);
      if (!url) return '';
      return `<a class="project-comment-attachment" href="${url}" target="_blank" rel="noopener">첨부 이미지 보기 ↗</a>`;
    }).join('');
    return `<article class="project-comment">
      <span class="project-detail-avatar">${esc(author.slice(0, 1))}</span>
      <div><div class="project-comment-meta"><strong>${esc(author)}</strong><span>${esc(formatDate(comment.created_at, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span></div>${comment.content ? `<p>${esc(comment.content)}</p>` : ''}${attachmentRows}</div>
    </article>`;
  }

  function projectDetailPanel(title, content, emptyText, className = '') {
    return `<section class="project-detail-panel ${className}">
      <header><strong>${esc(title)}</strong></header>
      <div class="project-detail-panel-body">${content || `<div class="project-detail-empty">${esc(emptyText)}</div>`}</div>
    </section>`;
  }

  function renderProjectDetail(project, tab = projectDetailTab) {
    projectDetailTab = tab;
    const status = PROJECT_STATUS[project.status] || PROJECT_STATUS.active;
    const tasks = Array.isArray(project.tasks) ? project.tasks : [];
    const updates = Array.isArray(project.updates) ? project.updates : [];
    const members = Array.isArray(project.members) ? project.members : [];
    const comments = Array.isArray(project.comments) ? project.comments : [];
    const events = Array.isArray(project.events) ? project.events : [];
    const doneTasks = tasks.filter(task => task.status === 'done').length;
    const percent = tasks.length ? Math.round(doneTasks / tasks.length * 100) : 0;
    const memberRows = members.map(member => `<span class="project-member-chip"><i>${esc((member.name || '?').slice(0, 1))}</i>${esc(member.name || member.email || '이름 없음')}${member.role === 'manager' ? '<b>담당</b>' : ''}</span>`).join('');
    const taskRows = tasks.map(projectTaskRow).join('');
    const updateRows = updates.map(projectUpdateRow).join('');
    const eventRows = events.map(projectEventRow).join('');
    const commentRows = comments.map(projectCommentRow).join('');
    const overview = `
      <div class="project-overview-grid">
        ${projectDetailPanel('개요', `<p class="project-description">${esc(project.description || '등록된 프로젝트 설명이 없습니다.')}</p>`, '')}
        ${projectDetailPanel('참여 멤버', `<div class="project-member-list">${memberRows || '<div class="project-detail-empty">등록된 참여 멤버가 없습니다.</div>'}</div>`, '')}
        ${projectDetailPanel('다음 업무', taskRows, '등록된 업무가 없습니다.')}
        ${projectDetailPanel('최근 진행사항', updates.slice(0, 5).map(projectUpdateRow).join(''), '아직 진행사항 기록이 없습니다.')}
      </div>`;
    const tabContent = {
      overview,
      tasks: projectDetailPanel(`업무 ${tasks.length}개`, taskRows, '등록된 업무가 없습니다.', 'project-detail-panel-wide'),
      updates: projectDetailPanel(`진행사항 ${updates.length}개`, updateRows, '아직 진행사항 기록이 없습니다.', 'project-detail-panel-wide'),
      schedule: projectDetailPanel(`일정 ${events.length}개`, eventRows, '등록된 프로젝트 일정이 없습니다.', 'project-detail-panel-wide')
    }[tab] || overview;

    reviewView.innerHTML = `
      <div class="project-detail-page">
        <header class="project-detail-toolbar">
          <div class="project-detail-heading"><span>▰</span><strong>프로젝트</strong></div>
          <div class="project-detail-actions">
            <button type="button" data-project-back>← 목록</button>
            <button type="button" class="primary" data-project-readonly-action>＋ 프로젝트</button>
            <button type="button" data-project-readonly-action>수정</button>
          </div>
        </header>
        <section class="project-detail-hero">
          <div>
            <div class="project-detail-hero-meta"><span class="review-card-status ${status[1]}">${esc(status[0])}</span>${project.deadline ? `<span>마감 ${esc(project.deadline)}</span>` : ''}</div>
            <h1>${esc(project.name || '프로젝트명 없음')}</h1>
            <p>담당 ${esc(project.owner_name || '미지정')} · 참여 ${members.length}명</p>
          </div>
          <div class="project-detail-progress"><span><b>진행률</b><strong>${percent}%</strong></span><div class="progress-track"><i style="width:${percent}%"></i></div><small>${doneTasks}/${tasks.length} 완료</small></div>
        </section>
        <nav class="project-detail-tabs" aria-label="프로젝트 상세 메뉴">
          ${[['overview','개요'],['tasks','업무'],['updates','진행사항'],['schedule','일정']].map(([key, label]) => `<button class="${tab === key ? 'active' : ''}" type="button" data-project-detail-tab="${key}">${label}</button>`).join('')}
        </nav>
        <div class="project-detail-layout">
          <main class="project-detail-main">${tabContent}</main>
          <aside class="project-conversation">
            <header><strong>프로젝트 전체 대화</strong><small>전체 공유는 여기, 업무별 확인사항은 업무를 선택해서 남깁니다.</small></header>
            <nav><button class="active" type="button">전체 ${comments.length}</button></nav>
            <div class="project-comment-list">${commentRows || '<div class="project-detail-empty">아직 프로젝트 전체 대화가 없습니다.</div>'}</div>
            <div class="project-comment-compose">
              <textarea disabled placeholder="프로젝트 전체 대화를 남겨주세요."></textarea>
              <span>이미지 첨부 (JPG, PNG)</span>
              <button type="button" disabled>등록</button>
              <small>읽기 전용 프리뷰입니다.</small>
            </div>
          </aside>
        </div>
      </div>`;

    reviewView.querySelector('[data-project-back]').addEventListener('click', renderProjects);
    reviewView.querySelectorAll('[data-project-detail-tab]').forEach(button => button.addEventListener('click', () => renderProjectDetail(project, button.dataset.projectDetailTab)));
    reviewView.querySelectorAll('[data-project-readonly-action]').forEach(button => button.addEventListener('click', () => showToast('읽기 전용 화면입니다. 변경은 기존 파라곤에서 진행해 주세요.')));
  }

  async function openProjectDetail(projectId) {
    projectDetailTab = 'overview';
    reviewView.innerHTML = `<div class="project-detail-loading"><strong>프로젝트를 불러오는 중입니다</strong><span>상세 데이터를 조회하고 있습니다.</span></div>`;
    try {
      const project = await readOnlyApi('/projects/' + encodeURIComponent(projectId));
      renderProjectDetail(project, 'overview');
    } catch (error) {
      reviewView.innerHTML = `<div class="project-detail-loading error"><strong>프로젝트를 불러오지 못했습니다</strong><span>${esc(error.message)}</span><button type="button" data-project-back>목록으로 돌아가기</button></div>`;
      reviewView.querySelector('[data-project-back]').addEventListener('click', renderProjects);
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

  function moduleStatusbar(title, detail, badge = 'MVP 기획 · 데이터 연결 전') {
    return `<div class="module-statusbar">
      <span><strong>${esc(title)}</strong><small>${esc(detail)}</small></span>
      <span class="module-plan-badge">${esc(badge)}</span>
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

  // 보고서 종류별 조회 기간·집계 단위. 서버의 sales-summary bucket과 짝을 이룬다.
  const SALES_REPORT_PERIODS = {
    daily: { bucket: 'day', rangeLabel: '최근 14일', span: { days: 14 } },
    weekly: { bucket: 'week', rangeLabel: '최근 8주', span: { weeks: 8 } },
    monthly: { bucket: 'month', rangeLabel: '최근 6개월', span: { months: 6 } },
    quarterly: { bucket: 'quarter', rangeLabel: '최근 4분기', span: { quarters: 4 } }
  };

  const SALES_SCOPE_LABEL = {
    all: '전체 지사·팀 보고서',
    group: '소속 부서와 본인 보고서',
    self: '본인 보고서'
  };

  function salesPeriodFor(type) {
    const config = SALES_REPORT_PERIODS[type];
    if (!config) return null;
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (config.span.days) start.setDate(start.getDate() - (config.span.days - 1));
    if (config.span.weeks) {
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      start.setDate(start.getDate() - (config.span.weeks - 1) * 7);
    }
    if (config.span.months) start.setMonth(start.getMonth() - (config.span.months - 1), 1);
    if (config.span.quarters) {
      start.setMonth(Math.floor(start.getMonth() / 3) * 3 - (config.span.quarters - 1) * 3, 1);
    }
    return { bucket: config.bucket, rangeLabel: config.rangeLabel, from: localDateKey(start), to: localDateKey(today) };
  }

  function salesBucketLabel(bucket, key) {
    const value = String(key || '');
    if (bucket === 'day') {
      const parts = value.split('-');
      return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : value;
    }
    if (bucket === 'week') {
      const start = new Date(`${value}T00:00:00`);
      if (Number.isNaN(start.getTime())) return value;
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return `${start.getMonth() + 1}/${start.getDate()}~${end.getMonth() + 1}/${end.getDate()}`;
    }
    if (bucket === 'month') return `${Number(value.slice(5, 7))}월`;
    if (bucket === 'quarter') return `${value.slice(-1)}분기`;
    return value;
  }

  function formatWon(value) {
    return `${Math.round(Number(value) || 0).toLocaleString('ko-KR')}원`;
  }

  // 큰 금액은 억·만 단위로 줄여 지표 카드에서 읽기 쉽게 표시한다.
  function formatWonShort(value) {
    const amount = Math.round(Number(value) || 0);
    if (amount >= 100000000) return `${(amount / 100000000).toFixed(1)}억원`;
    if (amount >= 10000) return `${Math.round(amount / 10000).toLocaleString('ko-KR')}만원`;
    return `${amount.toLocaleString('ko-KR')}원`;
  }

  function salesBucketTotals(data) {
    return (data.bucketKeys || []).map(key => ({
      key,
      label: salesBucketLabel(data.bucket, key),
      amount: (data.authors || []).reduce((sum, author) => sum + (author.amounts?.[key] || 0), 0)
    }));
  }

  function renderSalesChart(buckets) {
    const max = buckets.reduce((peak, item) => Math.max(peak, item.amount), 0);
    if (!max) return '';
    return `<div class="sales-chart" role="img" aria-label="기간별 보고 매출 막대 그래프">
      ${buckets.map(item => {
        const ratio = Math.max(2, Math.round((item.amount / max) * 100));
        return `<div class="sales-bar">
          <span class="sales-bar-value">${esc(formatWonShort(item.amount))}</span>
          <span class="sales-bar-track"><span class="sales-bar-fill" style="height:${ratio}%"></span></span>
          <span class="sales-bar-label">${esc(item.label)}</span>
        </div>`;
      }).join('')}
    </div>`;
  }

  function renderSalesAuthorTable(data, buckets) {
    if (!data.authors?.length) return '';
    return `<div class="sales-table-scroll">
      <table class="sales-table">
        <thead>
          <tr>
            <th scope="col">영업자</th>
            <th scope="col">소속</th>
            ${buckets.map(item => `<th scope="col">${esc(item.label)}</th>`).join('')}
            <th scope="col">합계</th>
            <th scope="col">보고서</th>
          </tr>
        </thead>
        <tbody>
          ${data.authors.map(author => `<tr>
            <th scope="row">${esc(author.name)}</th>
            <td class="sales-cell-group">${esc(author.groupName)}</td>
            ${buckets.map(item => {
              const amount = author.amounts?.[item.key] || 0;
              return `<td class="${amount ? '' : 'sales-cell-zero'}">${amount ? esc(amount.toLocaleString('ko-KR')) : '—'}</td>`;
            }).join('')}
            <td class="sales-cell-total">${esc(author.total.toLocaleString('ko-KR'))}</td>
            <td class="sales-cell-count">${esc(String(author.reportCount))}건</td>
          </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">합계</th>
            <td></td>
            ${buckets.map(item => `<td>${esc(item.amount.toLocaleString('ko-KR'))}</td>`).join('')}
            <td class="sales-cell-total">${esc(Number(data.totals?.amount || 0).toLocaleString('ko-KR'))}</td>
            <td class="sales-cell-count">${esc(String(data.totals?.reportCount || 0))}건</td>
          </tr>
        </tfoot>
      </table>
    </div>`;
  }

  function renderSalesFields(data) {
    const fields = (data.fields || []).slice(0, 8);
    if (!fields.length) return '';
    const max = fields[0].amount || 1;
    return `<div class="sales-field-list">
      ${fields.map(field => `<div class="sales-field">
        <span class="sales-field-name">${esc(field.name)}</span>
        <span class="sales-field-track"><span class="sales-field-fill" style="width:${Math.max(3, Math.round((field.amount / max) * 100))}%"></span></span>
        <span class="sales-field-amount">${esc(formatWon(field.amount))}</span>
      </div>`).join('')}
    </div>`;
  }

  function renderSalesSummaryPane() {
    const pane = document.getElementById('salesSummaryPane');
    if (!pane) return;

    if (salesSummary.status === 'loading') {
      pane.innerHTML = '<p class="sales-state">운영 보고서에서 매출을 집계하는 중입니다…</p>';
      return;
    }
    if (salesSummary.status === 'error') {
      pane.innerHTML = `<p class="sales-state sales-state-error">매출 집계를 불러오지 못했습니다. ${esc(salesSummary.error)}</p>`;
      return;
    }

    const data = salesSummary.data;
    if (!data) {
      pane.innerHTML = '';
      return;
    }

    const buckets = salesBucketTotals(data);
    const total = Number(data.totals?.amount || 0);
    if (!total) {
      pane.innerHTML = `<p class="sales-state">${esc(data.from)} ~ ${esc(data.to)} 기간에 조회 권한 범위 내 보고 매출이 없습니다.</p>`;
      return;
    }

    const changeRate = data.previous?.changeRate;
    const changeText = typeof changeRate === 'number'
      ? `${changeRate >= 0 ? '+' : ''}${(changeRate * 100).toFixed(1)}%`
      : '비교 구간 없음';
    const changeTone = typeof changeRate === 'number' ? (changeRate >= 0 ? 'up' : 'down') : '';

    pane.innerHTML = `
      <div class="sales-kpis">
        <article class="sales-kpi">
          <span>보고 매출</span>
          <strong>${esc(formatWonShort(total))}</strong>
          <small>${esc(formatWon(total))}</small>
        </article>
        <article class="sales-kpi">
          <span>보고서 수</span>
          <strong>${esc(Number(data.totals?.reportCount || 0).toLocaleString('ko-KR'))}건</strong>
          <small>영업자 ${esc(String(data.totals?.authorCount || 0))}명</small>
        </article>
        <article class="sales-kpi">
          <span>직전 구간 대비</span>
          <strong class="sales-change ${esc(changeTone)}">${esc(changeText)}</strong>
          <small>${esc(data.previous?.from || '')} ~ ${esc(data.previous?.to || '')} · ${esc(formatWonShort(data.previous?.amount || 0))}</small>
        </article>
      </div>
      ${renderSalesChart(buckets)}
      ${renderSalesAuthorTable(data, buckets)}
      ${renderSalesFields(data)}
      <p class="sales-basis">집계 기준 · 일일보고서의 매출 항목만 합산하며 수금액·미수잔액은 제외합니다. 조회 범위는 ${esc(SALES_SCOPE_LABEL[data.scope] || '허용된 보고서')}입니다.</p>`;
  }

  async function loadSalesSummary(type) {
    const period = salesPeriodFor(type);
    if (!period) return;
    const key = `${period.bucket}:${period.from}:${period.to}`;

    if (salesSummaryCache.has(key)) {
      salesSummary = { key, status: 'ready', data: salesSummaryCache.get(key), error: '' };
      renderSalesSummaryPane();
      return;
    }

    salesSummary = { key, status: 'loading', data: null, error: '' };
    renderSalesSummaryPane();

    try {
      const data = await readOnlyApi(`/reports/sales-summary?bucket=${encodeURIComponent(period.bucket)}&from=${period.from}&to=${period.to}`);
      salesSummaryCache.set(key, data);
      if (salesSummary.key !== key) return;
      salesSummary = { key, status: 'ready', data, error: '' };
    } catch (error) {
      if (salesSummary.key !== key) return;
      salesSummary = { key, status: 'error', data: null, error: error.message || '조회 실패' };
    }
    renderSalesSummaryPane();
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
    const period = salesPeriodFor(reportType);
    const content = reportType === 'attendance'
      ? renderAttendanceReport()
      : `<section class="module-section">
          <div class="module-section-head">
            <span><strong>${esc(selected[2])}</strong><small>${esc(period ? `${period.rangeLabel} · ${period.from} ~ ${period.to}` : '기간별 보고 매출')}</small></span>
            <span class="module-chip live">운영 보고서 연결</span>
          </div>
          <div class="module-section-body"><div id="salesSummaryPane" class="sales-pane"></div></div>
        </section>`;
    moduleView.innerHTML = `
      ${moduleStatusbar(
        '보고서 모듈',
        '출근 기록과 일일·주간·월말·분기별 매출 보고서를 한곳에서 관리합니다.',
        reportType === 'attendance' ? '근태 API 연결 전' : '운영 보고서 연결 · 읽기 전용'
      )}
      <div class="report-layout">
        <nav class="report-type-list" aria-label="보고서 종류">
          ${types.map(([key, icon, label, detail]) => `<button class="report-type-button ${reportType === key ? 'active' : ''}" type="button" data-report-type="${key}"><span class="report-type-icon">${icon}</span><span class="report-type-copy"><strong>${label}</strong><small>${detail}</small></span><span class="report-type-chevron">›</span></button>`).join('')}
        </nav>
        ${content}
      </div>
      <div class="module-security"><span>▣</span><span><strong>보고서 권한 기준</strong><br>대표는 전체 지사, 팀장은 소속 부서 전체와 본인, 일반 구성원은 본인 보고서만 조회합니다. 매출 집계도 같은 기준으로 서버에서 걸러 내려받습니다.</span></div>`;

    if (reportType !== 'attendance') {
      renderSalesSummaryPane();
      loadSalesSummary(reportType);
    }
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

  const COMPANY_CERTIFICATE_SLOTS = Object.freeze([
    { id: 'head-office', branch: '본사', filename: '본사 사업자등록증.png' },
    { id: 'jeonju-office', branch: '전주 지사', filename: '전주 지사 사업자등록증.png' },
    { id: 'daegu-office', branch: '대구 지사', filename: '대구 지사 사업자등록증.png' }
  ]);
  const CLIENT_COMPANY_DOCUMENT_LIMIT = 25;
  const COMPANY_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
  const COMPANY_DOCUMENT_MIME = Object.freeze({
    'image/png': { label: 'PNG', extension: '.png', minimumBytes: 24, signature: [137, 80, 78, 71, 13, 10, 26, 10] },
    'image/jpeg': { label: 'JPEG', extension: '.jpg', minimumBytes: 4, signature: [255, 216, 255] },
    'application/pdf': { label: 'PDF', extension: '.pdf', minimumBytes: 5, signature: [37, 80, 68, 70, 45] }
  });

  function ensureCompanyDocumentState() {
    const uid = String(currentUser?.uid || '');
    if (companyDocumentState.uid === uid) return;
    companyDocumentLoadGeneration += 1;
    companyDocumentState = { uid, status: 'idle', documents: [], error: '' };
  }

  function ensureClientCompanyDocumentState() {
    const uid = String(currentUser?.uid || '');
    if (clientCompanyDocumentState.uid === uid) return;
    window.clearTimeout(clientCompanyDocumentSearchTimer);
    clientCompanyDocumentSearchTimer = 0;
    clientCompanyDocumentLoadGeneration += 1;
    clientCompanyDocumentState = {
      uid, status: 'idle', documents: [], error: '', query: '', draftQuery: '',
      pagination: { page: 1, limit: CLIENT_COMPANY_DOCUMENT_LIMIT, total: 0, totalPages: 0 }
    };
  }

  function resetCompanyDocumentState() {
    window.clearTimeout(clientCompanyDocumentSearchTimer);
    clientCompanyDocumentSearchTimer = 0;
    companyDocumentLoadGeneration += 1;
    clientCompanyDocumentLoadGeneration += 1;
    companyDocumentFolder = 'branches';
    companyDocumentState = { uid: '', status: 'idle', documents: [], error: '' };
    clientCompanyDocumentState = {
      uid: '', status: 'idle', documents: [], error: '', query: '', draftQuery: '',
      pagination: { page: 1, limit: CLIENT_COMPANY_DOCUMENT_LIMIT, total: 0, totalPages: 0 }
    };
    if (activeView === 'company') moduleView.replaceChildren();
  }

  function loadCompanyDocuments() {
    ensureCompanyDocumentState();
    if (!currentUser || previewPersona || companyDocumentState.status === 'loading') return;
    const uid = String(currentUser.uid || '');
    const accessGeneration = osAuthAccessGeneration;
    const generation = ++companyDocumentLoadGeneration;
    companyDocumentState = { uid, status: 'loading', documents: [], error: '' };

    readOnlyApi('/peakos/company-documents').then(payload => {
      if (generation !== companyDocumentLoadGeneration
        || accessGeneration !== osAuthAccessGeneration
        || String(currentUser?.uid || '') !== uid) return;
      const allowed = new Set(COMPANY_CERTIFICATE_SLOTS.map(document => document.id));
      const documents = (Array.isArray(payload?.documents) ? payload.documents : [])
        .filter(document => allowed.has(String(document?.id || '')))
        .map(document => ({
          id: String(document.id),
          available: document.available === true,
          size: Math.max(0, Number(document.size) || 0),
          updatedAt: String(document.updatedAt || '')
        }));
      companyDocumentState = { uid, status: 'ready', documents, error: '' };
    }).catch(error => {
      if (generation !== companyDocumentLoadGeneration
        || accessGeneration !== osAuthAccessGeneration
        || String(currentUser?.uid || '') !== uid) return;
      companyDocumentState = {
        uid, status: 'error', documents: [],
        error: error.message || '보호 자료를 불러오지 못했습니다.'
      };
    }).finally(() => {
      if (generation === companyDocumentLoadGeneration
        && accessGeneration === osAuthAccessGeneration
        && activeView === 'company'
        && companyDocumentFolder === 'branches') renderPlannedModule('company');
    });
  }

  function normalizeClientCompanyDocument(document) {
    if (!document || typeof document !== 'object') return null;
    const id = String(document.id || '').trim().slice(0, 160);
    const mimeType = String(document.mimeType || '').trim().toLowerCase();
    if (!id || !COMPANY_DOCUMENT_MIME[mimeType]) return null;
    const rawSize = Number(document.size);
    const size = Number.isSafeInteger(rawSize) && rawSize >= 0 ? rawSize : 0;
    return {
      id,
      clientName: String(document.clientName || '거래처명 없음').trim().slice(0, 200) || '거래처명 없음',
      filename: String(document.filename || '사업자등록증').trim().slice(0, 240) || '사업자등록증',
      mimeType,
      size,
      updatedAt: String(document.updatedAt || '').trim().slice(0, 64),
      available: document.available === true,
      canPreview: document.canPreview === true && mimeType !== 'application/pdf'
    };
  }

  function normalizeClientCompanyPagination(pagination, requestedPage, documentCount) {
    const rawTotal = Number(pagination?.total);
    const total = Number.isSafeInteger(rawTotal) && rawTotal >= 0
      ? Math.max(documentCount, rawTotal)
      : documentCount;
    const calculatedPages = total ? Math.ceil(total / CLIENT_COMPANY_DOCUMENT_LIMIT) : 0;
    const rawTotalPages = Number(pagination?.totalPages);
    const totalPages = Number.isSafeInteger(rawTotalPages) && rawTotalPages >= calculatedPages
      ? rawTotalPages
      : calculatedPages;
    const rawPage = Number(pagination?.page);
    const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : requestedPage;
    return {
      page: totalPages ? Math.min(page, totalPages) : 1,
      limit: CLIENT_COMPANY_DOCUMENT_LIMIT,
      total,
      totalPages
    };
  }

  async function loadClientCompanyDocuments({
    query = clientCompanyDocumentState.query,
    page = clientCompanyDocumentState.pagination.page,
    restoreSearchFocus = false
  } = {}) {
    ensureClientCompanyDocumentState();
    if (!currentUser || previewPersona) return;
    const uid = String(currentUser.uid || '');
    const accessGeneration = osAuthAccessGeneration;
    const generation = ++clientCompanyDocumentLoadGeneration;
    const normalizedQuery = String(query || '').trim().slice(0, 80);
    const normalizedPage = Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
    const params = new URLSearchParams({
      folder: 'clients',
      q: normalizedQuery,
      page: String(normalizedPage),
      limit: String(CLIENT_COMPANY_DOCUMENT_LIMIT)
    });
    clientCompanyDocumentState = {
      ...clientCompanyDocumentState,
      uid,
      status: 'loading',
      documents: [],
      error: '',
      query: normalizedQuery,
      pagination: {
        ...clientCompanyDocumentState.pagination,
        page: normalizedPage,
        limit: CLIENT_COMPANY_DOCUMENT_LIMIT
      }
    };

    try {
      const payload = await readOnlyApi(`/peakos/company-documents?${params.toString()}`);
      if (generation !== clientCompanyDocumentLoadGeneration
        || accessGeneration !== osAuthAccessGeneration
        || String(currentUser?.uid || '') !== uid) return;
      const seen = new Set();
      const documents = (Array.isArray(payload?.documents) ? payload.documents : [])
        .map(normalizeClientCompanyDocument)
        .filter(document => {
          if (!document || seen.has(document.id)) return false;
          seen.add(document.id);
          return true;
        })
        .slice(0, CLIENT_COMPANY_DOCUMENT_LIMIT);
      clientCompanyDocumentState = {
        ...clientCompanyDocumentState,
        uid,
        status: 'ready',
        documents,
        error: '',
        query: normalizedQuery,
        pagination: normalizeClientCompanyPagination(payload?.pagination, normalizedPage, documents.length)
      };
    } catch (error) {
      if (generation !== clientCompanyDocumentLoadGeneration
        || accessGeneration !== osAuthAccessGeneration
        || String(currentUser?.uid || '') !== uid) return;
      clientCompanyDocumentState = {
        ...clientCompanyDocumentState,
        uid,
        status: 'error',
        documents: [],
        error: error.message || '거래처 보호 자료를 불러오지 못했습니다.',
        query: normalizedQuery,
        pagination: { page: normalizedPage, limit: CLIENT_COMPANY_DOCUMENT_LIMIT, total: 0, totalPages: 0 }
      };
    } finally {
      if (generation === clientCompanyDocumentLoadGeneration
        && accessGeneration === osAuthAccessGeneration
        && activeView === 'company'
        && companyDocumentFolder === 'clients') {
        const restoreFolderFocus = document.activeElement?.dataset?.companyFolder === 'clients';
        renderPlannedModule('company');
        if (restoreSearchFocus) {
          window.requestAnimationFrame(() => {
            const input = moduleView.querySelector('[data-company-client-search]');
            if (!input) return;
            input.focus();
            input.setSelectionRange?.(input.value.length, input.value.length);
          });
        } else if (restoreFolderFocus) {
          window.requestAnimationFrame(() => moduleView.querySelector('[data-company-folder="clients"]')?.focus());
        }
      }
    }
  }

  async function protectedCompanyDocumentBlob(id, allowedMimeTypes = ['image/png']) {
    if (!currentUser) throw new Error('로그인이 필요합니다.');
    const documentId = String(id || '').trim();
    const allowedTypes = new Set(allowedMimeTypes.filter(mimeType => COMPANY_DOCUMENT_MIME[mimeType]));
    if (!documentId || documentId.length > 160 || !allowedTypes.size) throw new Error('보호 원본 정보가 올바르지 않습니다.');
    const requestUser = currentUser;
    const requestUid = requestUser.uid;
    const accessGeneration = osAuthAccessGeneration;
    const stale = () => {
      const error = new Error('로그인 또는 추가 인증 상태가 바뀌어 요청을 취소했습니다.');
      error.code = 'AUTH_CONTEXT_CHANGED';
      return error;
    };
    const assertFresh = () => {
      if (!currentUser
        || currentUser.uid !== requestUid
        || accessGeneration !== osAuthAccessGeneration
        || (isOsRoute() && osAuthExpired)) throw stale();
    };
    const token = await requestUser.getIdToken();
    assertFresh();
    const response = await fetch(`/api/peakos/company-documents/${encodeURIComponent(documentId)}/content`, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token },
      cache: 'no-store',
      credentials: 'same-origin'
    });
    assertFresh();
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      assertFresh();
      const error = new Error(payload.error || `원본 조회 실패 (${response.status})`);
      error.status = response.status;
      error.code = payload.code || '';
      if (response.status === 401
        && ['OS_AUTH_SESSION_REQUIRED', 'OS_AUTH_SESSION_INVALID'].includes(error.code)) {
        lockOsAfterSessionExpiry();
      }
      throw error;
    }
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const fileType = COMPANY_DOCUMENT_MIME[contentType];
    if (!fileType || !allowedTypes.has(contentType)) throw new Error('보호 원본의 파일 형식이 올바르지 않습니다.');
    const blob = await response.blob();
    assertFresh();
    if (blob.size < fileType.minimumBytes || blob.size > COMPANY_DOCUMENT_MAX_BYTES) throw new Error('보호 원본의 파일 크기가 올바르지 않습니다.');
    const signature = [...new Uint8Array(await blob.slice(0, fileType.signature.length).arrayBuffer())];
    assertFresh();
    if (signature.some((byte, index) => byte !== fileType.signature[index])) {
      throw new Error(`보호 원본이 올바른 ${fileType.label} 파일이 아닙니다.`);
    }
    return blob;
  }

  function companyDocumentForAction(button, action) {
    const id = String(button.dataset[action] || '');
    if (button.dataset.companyDocumentFolder === 'clients') {
      return clientCompanyDocumentState.documents.find(document => document.id === id && document.available) || null;
    }
    const file = COMPANY_CERTIFICATE_SLOTS.find(document => document.id === id);
    const stored = companyDocumentState.documents.find(document => document.id === id);
    return file && stored?.available
      ? { ...file, mimeType: 'image/png', available: true, canPreview: true }
      : null;
  }

  function safeCompanyDocumentFilename(file) {
    const type = COMPANY_DOCUMENT_MIME[file.mimeType] || COMPANY_DOCUMENT_MIME['image/png'];
    const cleaned = String(file.filename || '사업자등록증')
      .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
      .trim()
      .slice(0, 180) || '사업자등록증';
    if (cleaned.toLowerCase().endsWith(type.extension)) return cleaned;
    return `${cleaned.replace(/\.[^.]{1,8}$/, '')}${type.extension}`;
  }

  async function previewCompanyDocument(button) {
    const file = companyDocumentForAction(button, 'companyDocumentPreview');
    if (!file) return;
    if (!file.canPreview || !['image/png', 'image/jpeg'].includes(file.mimeType)) {
      showToast('PDF 원본은 미리보기 없이 다운로드로만 제공합니다.');
      return;
    }
    openDetailModal(file.filename, '<div class="data-unavailable"><span class="data-unavailable-icon">▥</span><div><strong>보호 원본을 확인하고 있습니다</strong><p>권한과 파일 무결성을 검사한 뒤 화면에 표시합니다.</p></div></div>');
    companyDocumentPreviewTrigger = button;
    const generation = ++companyDocumentPreviewGeneration;
    button.disabled = true;
    document.getElementById('readonlyModalClose')?.focus();
    try {
      const blob = await protectedCompanyDocumentBlob(file.id, [file.mimeType]);
      if (generation !== companyDocumentPreviewGeneration) return;
      const modal = document.getElementById('readonlyDetailModal');
      if (!modal || modal.hidden) return;
      const bodySlot = document.getElementById('readonlyModalBody');
      bodySlot.innerHTML = '<div data-company-document-preview style="display:grid;gap:12px;justify-items:center"><p class="sales-basis">이 이미지는 브라우저 저장소에 보관하지 않습니다.</p></div>';
      const preview = bodySlot.querySelector('[data-company-document-preview]');
      const image = document.createElement('img');
      image.alt = file.filename;
      image.dataset.companyDocumentImage = file.id;
      image.style.cssText = 'display:block;max-width:100%;max-height:72vh;width:auto;height:auto;object-fit:contain';
      const objectUrl = URL.createObjectURL(blob);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        URL.revokeObjectURL(objectUrl);
      };
      companyDocumentPreviewCleanup = () => {
        image.removeAttribute('src');
        image.remove();
        release();
      };
      image.addEventListener('load', release, { once: true });
      image.addEventListener('error', () => {
        release();
        preview.innerHTML = '<p class="sales-state">원본 이미지를 표시하지 못했습니다.</p>';
      }, { once: true });
      preview.prepend(image);
      image.src = objectUrl;
    } catch (error) {
      const modal = document.getElementById('readonlyDetailModal');
      if (generation === companyDocumentPreviewGeneration && modal && !modal.hidden) {
        document.getElementById('readonlyModalTitle').textContent = file.filename;
        document.getElementById('readonlyModalBody').innerHTML = `<div class="data-unavailable"><span class="data-unavailable-icon">!</span><div><strong>원본을 열지 못했습니다</strong><p>${esc(error.message)}</p></div></div>`;
      }
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  async function downloadCompanyDocument(button) {
    const file = companyDocumentForAction(button, 'companyDocumentDownload');
    if (!file) return;
    button.disabled = true;
    const previousText = button.textContent;
    button.textContent = '확인 중…';
    try {
      const blob = await protectedCompanyDocumentBlob(file.id, [file.mimeType]);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = safeCompanyDocumentFilename(file);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      showToast(`${file.branch || file.clientName || '거래처'} 사업자등록증을 저장했습니다.`);
    } catch (error) {
      showToast(`사업자등록증을 저장하지 못했습니다. ${error.message}`);
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = previousText;
      }
    }
  }

  function companyDocumentSizeLabel(size) {
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes <= 0) return '크기 확인 필요';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}MB`;
    return `${Math.ceil(bytes / 1024).toLocaleString('ko-KR')}KB`;
  }

  function selectCompanyDocumentFolder(folder) {
    if (!['branches', 'clients'].includes(folder) || companyDocumentFolder === folder) return;
    if (folder === 'branches' && clientCompanyDocumentSearchTimer) {
      window.clearTimeout(clientCompanyDocumentSearchTimer);
      clientCompanyDocumentSearchTimer = 0;
    }
    companyDocumentFolder = folder;
    renderPlannedModule('company');
    window.requestAnimationFrame(() => moduleView.querySelector(`[data-company-folder="${folder}"]`)?.focus());
  }

  function runClientCompanyDocumentSearch({ immediate = false } = {}) {
    window.clearTimeout(clientCompanyDocumentSearchTimer);
    clientCompanyDocumentSearchTimer = 0;
    clientCompanyDocumentLoadGeneration += 1;
    if (clientCompanyDocumentState.status === 'loading') {
      clientCompanyDocumentState = { ...clientCompanyDocumentState, status: 'idle', documents: [], error: '' };
    }
    const start = () => {
      clientCompanyDocumentSearchTimer = 0;
      loadClientCompanyDocuments({
        query: clientCompanyDocumentState.draftQuery,
        page: 1,
        restoreSearchFocus: true
      });
    };
    if (immediate) start();
    else clientCompanyDocumentSearchTimer = window.setTimeout(start, 300);
  }

  function renderCompanyModule() {
    ensureCompanyDocumentState();
    ensureClientCompanyDocumentState();
    if (!previewPersona && companyDocumentState.status === 'idle') loadCompanyDocuments();
    if (!previewPersona && companyDocumentFolder === 'clients' && clientCompanyDocumentState.status === 'idle') {
      loadClientCompanyDocuments();
    }
    const metadata = new Map(companyDocumentState.documents.map(document => [document.id, document]));
    const previewLocked = Boolean(previewPersona);
    const availableCount = previewLocked
      ? 0
      : COMPANY_CERTIFICATE_SLOTS.filter(document => metadata.get(document.id)?.available).length;
    const canRetry = !previewLocked && (companyDocumentState.status === 'error'
      || (companyDocumentState.status === 'ready' && availableCount < COMPANY_CERTIFICATE_SLOTS.length));
    const branchStatusLabel = previewLocked
      ? '미리보기 중 비공개'
      : (companyDocumentState.status === 'loading' ? '보호 저장소 확인 중'
        : (companyDocumentState.status === 'error' ? '보호 저장소 연결 실패' : `보호 연결 ${availableCount}/3`));
    const clientTotal = previewLocked ? 0 : Number(clientCompanyDocumentState.pagination.total || 0);
    const clientStatusLabel = previewLocked ? '미리보기 중 비공개'
      : (clientCompanyDocumentState.status === 'loading' ? '거래처 문서 확인 중'
        : (clientCompanyDocumentState.status === 'error' ? '거래처 문서 조회 실패'
          : (clientCompanyDocumentState.status === 'ready' ? `거래처 문서 ${clientTotal.toLocaleString('ko-KR')}개` : '선택 후 조회')));
    const statusLabel = companyDocumentFolder === 'clients' ? clientStatusLabel : branchStatusLabel;
    const branchRows = COMPANY_CERTIFICATE_SLOTS.map(document => {
      const stored = metadata.get(document.id);
      const available = !previewLocked && stored?.available === true;
      const stateText = previewLocked ? '미리보기 중 비공개'
        : (companyDocumentState.status === 'loading' ? '원본 확인 중'
          : (available ? '보호 연결 완료' : '원본 점검 필요'));
      const metaText = available && stored.size
        ? `PNG · ${Math.ceil(stored.size / 1024).toLocaleString('ko-KR')}KB`
        : '권한 확인 후 열람';
      return `<tr data-company-certificate="${esc(document.id)}"><th scope="row">${esc(document.branch)}</th><td>${esc(document.filename)}</td><td><span class="vendor-chip ${available ? 'done' : ''}">${esc(stateText)}</span></td><td>${esc(metaText)}</td><td><span style="display:flex;gap:6px;flex-wrap:wrap"><button class="module-action" type="button" data-company-document-preview="${esc(document.id)}" aria-label="${esc(`${document.branch} 사업자등록증 미리보기`)}" ${available ? '' : 'disabled'}>미리보기</button><button class="module-action" type="button" data-company-document-download="${esc(document.id)}" aria-label="${esc(`${document.branch} 사업자등록증 PNG 저장`)}" ${available ? '' : 'disabled'}>PNG 저장</button></span></td></tr>`;
    }).join('');
    const clientCanRetry = !previewLocked && (clientCompanyDocumentState.status === 'error'
      || (clientCompanyDocumentState.status === 'ready'
        && clientCompanyDocumentState.documents.some(document => !document.available)));
    const clientRows = previewLocked ? '' : clientCompanyDocumentState.documents.map(document => {
      const type = COMPANY_DOCUMENT_MIME[document.mimeType];
      const available = !previewLocked && document.available;
      const previewable = available && document.canPreview && document.mimeType !== 'application/pdf';
      const ownerAndFile = `${document.clientName} ${document.filename}`;
      const previewAction = document.mimeType === 'application/pdf'
        ? `<span class="module-chip" data-company-document-download-only="${esc(document.id)}" aria-label="${esc(`${ownerAndFile} PDF는 다운로드만 가능`)}">PDF · 다운로드만</span>`
        : `<button class="module-action" type="button" data-company-document-preview="${esc(document.id)}" data-company-document-folder="clients" aria-label="${esc(`${ownerAndFile} 미리보기${previewable ? '' : ' 불가'}`)}" ${previewable ? '' : 'disabled'}>${previewable ? '미리보기' : '미리보기 불가'}</button>`;
      const changed = document.updatedAt ? formatDate(document.updatedAt, { year: 'numeric', month: '2-digit', day: '2-digit' }) : '수정일 확인 필요';
      return `<tr data-company-client-document="${esc(document.id)}"><th scope="row" title="${esc(document.clientName)}" style="max-width:260px;white-space:normal;overflow-wrap:anywhere;word-break:break-word">${esc(document.clientName)}</th><td title="${esc(document.filename)}" style="max-width:280px;white-space:normal;overflow-wrap:anywhere;word-break:break-word">${esc(document.filename)}</td><td>${esc(type.label)} · ${esc(companyDocumentSizeLabel(document.size))}<br><span class="sales-basis">${esc(changed)}</span></td><td><span class="vendor-chip ${available ? 'done' : ''}">${available ? '보호 연결 완료' : '원본 점검 필요'}</span></td><td><span style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${previewAction}<button class="module-action" type="button" data-company-document-download="${esc(document.id)}" data-company-document-folder="clients" aria-label="${esc(`${ownerAndFile} ${type.label} 저장`)}" ${available ? '' : 'disabled'}>${esc(type.label)} 저장</button></span></td></tr>`;
    }).join('');
    const branchSelected = companyDocumentFolder === 'branches';
    const clientSelected = companyDocumentFolder === 'clients';
    const branchSection = `<section class="module-section" id="companyFolderContent" data-company-folder-content="branches">
        <div class="module-section-head"><span><strong>본사 및 지사 사업자등록증</strong><small>Firebase 로그인·추가 이메일 인증·지정 UID 권한을 모두 확인합니다</small></span>${canRetry ? '<button class="module-action" type="button" data-company-document-refresh>다시 확인</button>' : '<span class="module-chip restricted">민감자료 · 3개</span>'}</div>
        <div class="module-section-body" style="padding:0">
          ${companyDocumentState.status === 'error' && !previewLocked ? `<div class="data-unavailable"><span class="data-unavailable-icon">!</span><div><strong>보호 자료를 불러오지 못했습니다</strong><p>${esc(companyDocumentState.error)}</p></div></div>` : ''}
          <div class="sales-table-scroll"><table class="empty-table">
            <thead><tr><th>구분</th><th>파일명</th><th>원본 상태</th><th>파일 정보</th><th>작업</th></tr></thead>
            <tbody>${branchRows}</tbody>
          </table></div>
        </div>
      </section>`;
    const clientResultStatus = previewLocked ? '계정 미리보기에서는 거래처 원본을 표시하지 않습니다.'
      : (clientCompanyDocumentState.status === 'loading' ? '거래처 문서를 불러오고 있습니다.'
        : (clientCompanyDocumentState.status === 'error' ? '거래처 문서 조회에 실패했습니다.'
          : `전체 ${clientTotal.toLocaleString('ko-KR')}건 중 ${clientCompanyDocumentState.documents.length.toLocaleString('ko-KR')}건 표시`));
    const clientPagination = clientCompanyDocumentState.pagination;
    const clientEmpty = !previewLocked && clientCompanyDocumentState.status === 'ready' && !clientCompanyDocumentState.documents.length;
    const clientSection = `<section class="module-section" id="companyFolderContent" data-company-folder-content="clients">
        <div class="module-section-head"><span><strong>거래처 사업자등록증</strong><small>회사·지사 문서와 분리된 거래처 전용 보호 폴더입니다</small></span>${clientCanRetry ? '<button class="module-action" type="button" data-company-client-refresh>다시 확인</button>' : `<span class="module-chip">${esc(clientTotal.toLocaleString('ko-KR'))}개</span>`}</div>
        <div class="module-section-body">
          <form class="ledger-filter" data-company-client-search-form role="search" aria-label="거래처 사업자등록증 검색">
            <label class="ledger-filter-field"><span>거래처명 또는 파일명</span><input type="search" data-company-client-search maxlength="80" autocomplete="off" value="${previewLocked ? '' : esc(clientCompanyDocumentState.draftQuery)}" placeholder="거래처명 검색" aria-describedby="companyClientResultStatus" style="min-width:min(360px,72vw);max-width:100%" ${previewLocked ? 'disabled' : ''}></label>
            <button class="module-action" type="submit" aria-label="거래처 사업자등록증 검색 실행" ${previewLocked ? 'disabled' : ''}>검색</button>
            ${!previewLocked && (clientCompanyDocumentState.draftQuery || clientCompanyDocumentState.query) ? '<button class="module-action" type="button" data-company-client-search-reset aria-label="거래처 검색어 지우기">검색어 지우기</button>' : ''}
            <span id="companyClientResultStatus" role="status" aria-live="polite">${esc(clientResultStatus)}</span>
          </form>
          ${clientCompanyDocumentState.status === 'error' && !previewLocked ? `<div class="data-unavailable"><span class="data-unavailable-icon">!</span><div><strong>거래처 보호 자료를 불러오지 못했습니다</strong><p>${esc(clientCompanyDocumentState.error)}</p></div></div>` : ''}
          ${previewLocked ? '<div class="data-unavailable"><span class="data-unavailable-icon">▤</span><div><strong>계정 미리보기 중에는 열 수 없습니다</strong><p>실제 로그인 계정으로 돌아온 뒤 권한을 다시 확인해 주세요.</p></div></div>' : ''}
          ${!previewLocked && clientCompanyDocumentState.status === 'loading' ? '<p class="sales-state" data-company-client-loading>거래처 보호 문서를 불러오고 있습니다.</p>' : ''}
          ${!previewLocked && clientCompanyDocumentState.status === 'ready' && clientRows ? `<div class="sales-table-scroll"><table class="empty-table" data-company-client-documents>
            <thead><tr><th>거래처</th><th>파일명</th><th>파일 정보</th><th>원본 상태</th><th>작업</th></tr></thead><tbody>${clientRows}</tbody>
          </table></div>` : ''}
          ${clientEmpty ? `<div class="data-unavailable"><span class="data-unavailable-icon">▤</span><div><strong>${clientCompanyDocumentState.query ? '검색 결과가 없습니다' : '등록된 거래처 사업자등록증이 없습니다'}</strong><p>${clientCompanyDocumentState.query ? '다른 거래처명 또는 파일명으로 검색해 주세요.' : '거래처 원본이 등록되면 이 보호 폴더에 표시합니다.'}</p></div></div>` : ''}
          ${!previewLocked && clientCompanyDocumentState.status === 'ready' && Number(clientPagination.totalPages || 0) > 1 ? `<div class="bank-pagination" aria-label="거래처 사업자등록증 페이지">
            <button class="module-action" type="button" data-company-client-page="${Math.max(1, Number(clientPagination.page) - 1)}" aria-label="이전 거래처 문서 페이지" ${Number(clientPagination.page) <= 1 ? 'disabled' : ''}>이전</button>
            <span>${Number(clientPagination.page).toLocaleString('ko-KR')} / ${Number(clientPagination.totalPages).toLocaleString('ko-KR')} 페이지</span>
            <button class="module-action" type="button" data-company-client-page="${Math.min(Number(clientPagination.totalPages), Number(clientPagination.page) + 1)}" aria-label="다음 거래처 문서 페이지" ${Number(clientPagination.page) >= Number(clientPagination.totalPages) ? 'disabled' : ''}>다음</button>
          </div>` : ''}
        </div>
      </section>`;
    moduleView.innerHTML = `
      ${moduleStatusbar('회사 자료 모듈', '사업자등록증을 회사·지사 자료와 거래처 자료로 나눠 관리합니다.', statusLabel)}
      <section class="module-grid two" data-company-certificate-folders>
        <article class="module-card" data-company-folder="branches" role="button" tabindex="0" aria-pressed="${branchSelected}" aria-controls="companyFolderContent" aria-label="본사 및 지사 사업자등록증 폴더 열기" style="cursor:pointer;${branchSelected ? 'border-color:#348ecd;box-shadow:0 0 0 2px rgba(52,142,205,.12)' : ''}">
          <div class="module-card-top"><span class="module-card-icon">▥</span><span class="module-chip restricted">${availableCount}/3 연결</span></div>
          <h2>본사 및 지사 사업자등록증</h2>
          <p>본사, 전주 지사, 대구 지사의 보호 원본을 권한 확인 후 열람하고 저장합니다.</p>
          <div class="module-card-footer"><span>본사 · 전주 · 대구</span><span class="module-chip">${branchSelected ? '선택됨' : '회사 문서'}</span></div>
        </article>
        <article class="module-card" data-company-folder="clients" role="button" tabindex="0" aria-pressed="${clientSelected}" aria-controls="companyFolderContent" aria-label="거래처 사업자등록증 폴더 열기" style="cursor:pointer;${clientSelected ? 'border-color:#6658bd;box-shadow:0 0 0 2px rgba(102,88,189,.12)' : ''}">
          <div class="module-card-top"><span class="module-card-icon violet">▤</span><span class="module-chip visible">${esc(clientStatusLabel)}</span></div>
          <h2>거래처 사업자등록증</h2>
          <p>거래처에서 받은 사업자등록증을 회사 문서와 섞이지 않도록 별도 폴더에서 관리합니다.</p>
          <div class="module-card-footer"><span>거래처별 분류</span><span class="module-chip">${clientSelected ? '선택됨' : '거래처 문서'}</span></div>
        </article>
      </section>
      ${branchSelected ? branchSection : clientSection}
      <section class="module-grid">
        ${moduleCard({ icon: '◇', tone: 'violet', title: '기타 회사 자료', description: '회사소개서, 법인 기본자료, 계좌 사본과 계약에 필요한 공식 자료를 관리합니다.', chip: '권한 적용', chipClass: 'visible', footer: '직급·팀별 접근 제어', action: '분류 보기' })}
      </section>
      <div class="module-security"><span>▣</span><span><strong>원본은 GitHub와 공개 URL에 저장되지 않습니다</strong><br>서버 전용 저장소에서 파일 무결성을 확인하고 모든 목록·열람 요청을 기록합니다.</span></div>`;

    moduleView.querySelectorAll('[data-company-folder]').forEach(card => {
      const select = () => selectCompanyDocumentFolder(card.dataset.companyFolder);
      card.addEventListener('click', select);
      card.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        select();
      });
    });
    moduleView.querySelector('[data-company-document-refresh]')?.addEventListener('click', () => {
      companyDocumentState = { ...companyDocumentState, status: 'idle', documents: [], error: '' };
      renderPlannedModule('company');
    });
    moduleView.querySelector('[data-company-client-refresh]')?.addEventListener('click', event => {
      event.currentTarget.disabled = true;
      loadClientCompanyDocuments({
        query: clientCompanyDocumentState.query,
        page: clientCompanyDocumentState.pagination.page
      });
    });
    const clientSearch = moduleView.querySelector('[data-company-client-search]');
    clientSearch?.addEventListener('input', () => {
      clientCompanyDocumentState.draftQuery = String(clientSearch.value || '').slice(0, 80);
      runClientCompanyDocumentSearch();
    });
    moduleView.querySelector('[data-company-client-search-form]')?.addEventListener('submit', event => {
      event.preventDefault();
      clientCompanyDocumentState.draftQuery = String(clientSearch?.value || '').slice(0, 80);
      runClientCompanyDocumentSearch({ immediate: true });
    });
    moduleView.querySelector('[data-company-client-search-reset]')?.addEventListener('click', () => {
      clientCompanyDocumentState.draftQuery = '';
      if (clientSearch) clientSearch.value = '';
      runClientCompanyDocumentSearch({ immediate: true });
    });
    moduleView.querySelectorAll('[data-company-client-page]').forEach(button => button.addEventListener('click', () => {
      const page = Number(button.dataset.companyClientPage);
      const totalPages = Number(clientCompanyDocumentState.pagination.totalPages || 0);
      if (!Number.isSafeInteger(page) || page < 1 || page > totalPages) return;
      button.disabled = true;
      loadClientCompanyDocuments({ query: clientCompanyDocumentState.query, page });
    }));
    moduleView.querySelectorAll('[data-company-document-preview]').forEach(button => {
      button.addEventListener('click', () => previewCompanyDocument(button));
    });
    moduleView.querySelectorAll('[data-company-document-download]').forEach(button => {
      button.addEventListener('click', () => downloadCompanyDocument(button));
    });
  }

  const ORG_RANK_STORAGE_KEY = 'peakos.orgRankDraft';

  function loadOrgRankDraft() {
    try {
      const saved = JSON.parse(localStorage.getItem(ORG_RANK_STORAGE_KEY) || '{}');
      orgRankDraft = saved && typeof saved === 'object' ? saved : {};
    } catch (error) {
      orgRankDraft = {};
    }
  }

  function saveOrgRankDraft() {
    try {
      localStorage.setItem(ORG_RANK_STORAGE_KEY, JSON.stringify(orgRankDraft));
    } catch (error) {
      /* 저장 공간이 막혀 있어도 화면 동작은 유지한다 */
    }
  }

  function orgRankOf(member) {
    return orgRankDraft[member.name] || member.rank || ORG_RANK_UNSET;
  }

  function orgRankOrder(rank) {
    const index = ORG_RANKS.indexOf(rank);
    return index === -1 ? ORG_RANKS.length : index;
  }

  // 조직도에 적힌 모든 구성원을 지사·팀 정보와 함께 한 줄로 펼친다.
  function orgRoster() {
    const rows = [];
    ORG_STRUCTURE.forEach(branch => {
      if (branch.lead) rows.push({ ...branch.lead, branch, divisionName: '지사 총괄', teamName: '' });
      branch.divisions.forEach(division => {
        division.members.forEach(member => rows.push({ ...member, branch, divisionName: division.name, teamName: '' }));
        (division.teams || []).forEach(team => {
          team.members.forEach(member => rows.push({ ...member, branch, divisionName: division.name, teamName: team.name }));
        });
      });
    });
    return rows;
  }

  function orgAccountFor(name) {
    return orgDirectory.accounts.find(account => String(account.name || '').trim() === String(name || '').trim()) || null;
  }

  // 로그인 계정의 직급. 조직도에 없으면 admin만 대표로 취급한다.
  function currentOrgRank() {
    const myName = String(userDoc?.name || '').trim();
    const mine = orgRoster().find(row => row.name === myName);
    if (mine) return orgRankOf(mine);
    return userDoc?.role === 'admin' ? '대표' : ORG_RANK_UNSET;
  }

  function canManagePermissions() {
    return orgRankOrder(currentOrgRank()) <= ORG_RANK_MANAGE_FROM;
  }

  async function loadOrgDirectory() {
    if (orgDirectory.status === 'loading' || orgDirectory.status === 'ready') return;
    orgDirectory = { status: 'loading', accounts: [] };
    try {
      const accounts = await readOnlyApi('/users/all-approved');
      orgDirectory = { status: 'ready', accounts: Array.isArray(accounts) ? accounts : [] };
    } catch (error) {
      orgDirectory = { status: 'error', accounts: [] };
    }
    // 조직도가 아직 화면에 떠 있을 때만 다시 그린다
    if (document.querySelector('[data-org-branch-filter]')) renderPlannedModule('organization');
  }

  function renderOrgMemberRow(member) {
    const rank = orgRankOf(member);
    const account = orgAccountFor(member.name);
    const isMe = account && account.uid === userDoc?.uid;
    return `<div class="org-member ${isMe ? 'current' : ''}">
      <span class="org-member-name">${esc(member.name)}${isMe ? '<span class="org-current-badge">나</span>' : ''}</span>
      <label class="org-member-rank">
        <span class="visually-hidden">${esc(member.name)} 직급</span>
        <select data-org-rank="${esc(member.name)}" ${canManagePermissions() ? '' : 'disabled'}>
          ${[ORG_RANK_UNSET, ...ORG_RANKS].map(option =>
            `<option value="${esc(option)}" ${option === rank ? 'selected' : ''}>${esc(option)}</option>`).join('')}
        </select>
      </label>
      <span class="org-member-account ${account ? 'linked' : 'missing'}">${account ? '계정 연결됨' : '계정 없음'}</span>
    </div>`;
  }

  // ── 보기 모드: 대표를 정점으로 아래로 갈라지는 피라미드 ──────────
  function orgNodeMember(member) {
    const account = orgAccountFor(member.name);
    const isMe = account && account.uid === userDoc?.uid;
    return `<div class="org-node person ${isMe ? 'current' : ''}">
      <strong>${esc(member.name)}</strong>
      <small>${esc(orgRankOf(member))}</small>
    </div>`;
  }

  // 직급 순으로만 정렬한다. 같은 직급이면 조직도에 적은 순서를 지킨다.
  function orgSortByRank(members) {
    return [...members].sort((a, b) =>
      orgRankOrder(orgRankOf(a)) - orgRankOrder(orgRankOf(b)));
  }

  // 조직도에서는 팀 이름 끝의 '팀'을 떼고 보여 준다
  function orgDisplayName(name) {
    const value = String(name || '');
    return value.length > 1 && value.endsWith('팀') ? value.slice(0, -1) : value;
  }

  // 카드 안에 들어가는 구성원 한 줄
  function orgPersonLine(member) {
    const account = orgAccountFor(member.name);
    const isMe = account && account.uid === userDoc?.uid;
    return `<span class="org-person ${isMe ? 'me' : ''}">
      <strong>${esc(member.name)}</strong><small>${esc(orgRankOf(member))}</small>
    </span>`;
  }

  // 팀 카드. 팀 이름 아래에 소속 구성원을 직급 순으로 나열한다.
  function orgCardNode({ icon = '', title, detail = '', members = [], kind = '', current = false }) {
    return `<div class="org-node ${kind} ${current ? 'current' : ''}">
      <strong>${icon ? `${esc(icon)} ` : ''}${esc(orgDisplayName(title))}</strong>
      ${detail ? `<small>${esc(detail)}</small>` : ''}
      ${current ? '<small class="org-node-mine">내 소속</small>' : ''}
      ${members.length ? `<span class="org-person-list">${orgSortByRank(members).map(orgPersonLine).join('')}</span>` : ''}
    </div>`;
  }

  function orgTreeDivision(division, currentGroupName) {
    const isCurrent = Boolean(currentGroupName)
      && (division.name.includes(currentGroupName) || currentGroupName.includes(division.name));

    // 팀 최상위 직급은 팀 카드 바로 아래에 세우고, 나머지 구성원은
    // 하위팀들과 같은 줄에 카드 하나로 묶는다.
    const sorted = orgSortByRank(division.members);
    const topRank = sorted.length ? orgRankOf(sorted[0]) : null;
    const leaders = sorted.filter(member => orgRankOf(member) === topRank);
    const rest = sorted.filter(member => orgRankOf(member) !== topRank);

    const children = [];
    if (rest.length) {
      children.push(`<li>${orgCardNode({ title: division.name, members: rest, kind: 'roster' })}</li>`);
    }
    (division.teams || []).forEach(team => {
      const teamCurrent = Boolean(currentGroupName) && team.name.includes(currentGroupName);
      children.push(`<li>${orgCardNode({
        icon: team.icon || '◎',
        title: team.name,
        members: team.members,
        kind: 'team sub',
        current: teamCurrent
      })}</li>`);
    });

    const childList = children.length ? `<ul>${children.join('')}</ul>` : '';
    const leaderRow = leaders.length > 1
      ? `<div class="org-tier">${leaders.map(orgNodeMember).join('')}</div>`
      : (leaders.length ? orgNodeMember(leaders[0]) : '');

    return `<li>
      ${orgCardNode({
        icon: division.icon || '◆',
        title: division.name,
        detail: division.detail,
        kind: `team ${division.tone || ''}`,
        current: isCurrent
      })}
      ${leaders.length
        ? `<ul><li>${leaderRow}${childList}</li></ul>`
        : childList}
    </li>`;
  }

  function renderOrgTree(branch) {
    const currentGroupName = String(userDoc?.group_name || '').trim();
    return `<div class="org-tree" data-org-tree>
      <div class="org-tree-scale">
        <ul>
          <li>
            <div class="org-node lead ${branch.lead?.master ? 'master' : ''}">
              <strong>♛ ${esc(branch.lead?.name || branch.name)}</strong>
              <small>${esc(branch.name)} · ${esc(branch.lead ? orgRankOf(branch.lead) : '대표')}</small>
              ${branch.lead?.master ? '<span class="org-master-chip">MASTER</span>' : ''}
            </div>
            ${branch.divisions.length
              ? `<ul>${branch.divisions.map(division => orgTreeDivision(division, currentGroupName)).join('')}</ul>`
              : ''}
          </li>
        </ul>
      </div>
    </div>
    ${branch.divisions.length ? '' : '<p class="org-branch-empty">아직 등록된 하위 조직이 없습니다.</p>'}`;
  }

  function renderOrgDivision(division) {
    const currentGroupName = String(userDoc?.group_name || '').trim();
    const isCurrent = currentGroupName && (division.name.includes(currentGroupName) || currentGroupName.includes(division.name));
    return `<article class="org-division ${isCurrent ? 'current' : ''}">
      <header class="org-division-head">
        <span class="org-node-icon ${esc(division.tone || '')}">${esc(division.icon || '◆')}</span>
        <span class="org-node-copy"><strong>${esc(orgDisplayName(division.name))}</strong><small>${esc(division.detail || '')}</small></span>
        ${isCurrent ? '<span class="org-current-badge">내 소속</span>' : ''}
      </header>
      ${division.members.length ? `<div class="org-member-list">${division.members.map(renderOrgMemberRow).join('')}</div>` : ''}
      ${(division.teams || []).map(team => {
        const teamCurrent = currentGroupName && team.name.includes(currentGroupName);
        return `<section class="org-subteam ${teamCurrent ? 'current' : ''}">
          <header class="org-subteam-head"><span>${esc(team.icon || '◎')}</span><strong>${esc(orgDisplayName(team.name))}</strong>${teamCurrent ? '<span class="org-current-badge">내 소속</span>' : ''}</header>
          <div class="org-member-list">${team.members.map(renderOrgMemberRow).join('')}</div>
        </section>`;
      }).join('')}
    </article>`;
  }

  function renderOrgBranch(branch) {
    // 보기는 피라미드, 수정은 세로 나열
    if (!orgEditMode) {
        // 갈래가 여럿인 지사는 한 줄을 다 쓰고, 작은 지사는 옆으로 나란히 놓는다
      return `<section class="org-branch ${branch.divisions.length > 1 ? 'wide' : ''}" data-org-branch="${esc(branch.id)}">${renderOrgTree(branch)}</section>`;
    }
    return `<section class="org-branch" data-org-branch="${esc(branch.id)}">
      <article class="org-master-node ${branch.lead?.master ? 'master' : ''}">
        <span class="org-node-icon">♛</span>
        <span class="org-node-copy">
          <strong>${esc(branch.name)} · ${esc(branch.lead ? orgRankOf(branch.lead) : '대표')} ${esc(branch.lead?.name || '')}</strong>
          <small>${esc(branch.lead?.detail || '')}</small>
        </span>
        ${branch.lead?.master ? '<span class="org-master-chip">MASTER</span>' : ''}
      </article>
      ${branch.divisions.length
        ? `<div class="org-vertical-line"></div><div class="org-divisions">${branch.divisions.map(renderOrgDivision).join('')}</div>`
        : '<p class="org-branch-empty">아직 등록된 하위 조직이 없습니다.</p>'}
    </section>`;
  }

  // 조직도에 없는 계정을 숨기지 않고 따로 모아 보여 준다.
  function renderOrgUnassigned() {
    if (orgDirectory.status !== 'ready') return '';
    const rosterNames = new Set(orgRoster().map(row => row.name));
    const unassigned = orgDirectory.accounts.filter(account => !rosterNames.has(String(account.name || '').trim()));
    if (!unassigned.length) return '';
    return `<section class="module-section">
      <div class="module-section-head">
        <span><strong>조직도 미배치 계정</strong><small>로그인 계정은 있으나 위 조직도에서 이름을 찾지 못했습니다</small></span>
        <span class="module-chip restricted">${esc(String(unassigned.length))}건</span>
      </div>
      <div class="module-section-body">
        <div class="org-member-list">
          ${unassigned.map(account => `<div class="org-member">
            <span class="org-member-name">${esc(account.name || '이름 없음')}</span>
            <span class="org-member-rank-static">${esc(account.group_name || '소속 미지정')}</span>
            <span class="org-member-account linked">계정 있음</span>
          </div>`).join('')}
        </div>
      </div>
    </section>`;
  }

  // 트리를 화면 폭에 맞춘다. 넘치면 줄이고, 남으면 키워서 빈 공간을 채운다.
  // 너무 작아지면 글자를 못 읽으니 하한을 두고 그 아래로는 가로 스크롤로,
  // 너무 커지면 어색하니 상한을 둔다.
  const ORG_TREE_MIN_SCALE = 0.72;
  const ORG_TREE_MAX_SCALE = 1.5;
  const ORG_TREE_FIT_MIN_WIDTH = 700;

  function fitOrgTrees() {
    document.querySelectorAll('[data-org-tree]').forEach(tree => {
      const scaler = tree.querySelector('.org-tree-scale');
      if (!scaler) return;
      scaler.style.transform = '';
      scaler.style.transformOrigin = '';
      tree.style.height = '';
      tree.classList.remove('scrollable');

      const available = tree.clientWidth;
      const natural = scaler.offsetWidth;
      if (!available || !natural) return;

      const wanted = available / natural;
      let scale;
      if (natural > available) {
        // 좁은 화면은 줄여 봐야 못 읽으니 그대로 두고 가로로 넘긴다
        if (available < ORG_TREE_FIT_MIN_WIDTH) {
          tree.classList.add('scrollable');
          return;
        }
        scale = Math.max(ORG_TREE_MIN_SCALE, wanted);
        if (wanted < ORG_TREE_MIN_SCALE) tree.classList.add('scrollable');
        // 줄일 때는 왼쪽부터 채워야 잘리는 노드가 없다
        scaler.style.transformOrigin = 'top left';
      } else {
        scale = Math.min(ORG_TREE_MAX_SCALE, wanted);
        if (scale <= 1.02) return;
        // 키울 때는 가운데를 기준으로 벌린다
        scaler.style.transformOrigin = 'top center';
      }

      scaler.style.transform = `scale(${scale})`;
      tree.style.height = `${Math.ceil(scaler.offsetHeight * scale)}px`;
    });
  }

  function renderOrganizationModule() {
    const canManageOrganization = canManagePermissions();
    const branches = ORG_STRUCTURE.filter(branch => orgBranchFilter === 'all' || branch.id === orgBranchFilter);
    moduleView.innerHTML = `
      <section class="module-section">
        <div class="module-section-head">
          <span><strong>전체 조직 구조</strong><small>현재 로그인 계정의 소속은 파란색으로 강조됩니다</small></span>
          <span class="org-toolbar">
            <label class="org-branch-filter">
              <span class="visually-hidden">지사 선택</span>
              <select data-org-branch-filter>
                <option value="all" ${orgBranchFilter === 'all' ? 'selected' : ''}>전체 지사</option>
                ${ORG_STRUCTURE.map(branch => `<option value="${esc(branch.id)}" ${orgBranchFilter === branch.id ? 'selected' : ''}>${esc(branch.name)}</option>`).join('')}
              </select>
            </label>
            ${canManageOrganization ? `<button class="module-action ${orgEditMode ? 'active' : ''}" type="button" data-org-edit-toggle>${orgEditMode ? '수정 완료' : '직급 수정'}</button>` : ''}
            ${canManageOrganization ? '<button class="module-action" type="button" data-open-permissions>권한 관리</button>' : ''}
          </span>
        </div>
        <div class="module-section-body">
          <div class="org-chart ${orgEditMode ? 'edit' : 'view'}">${branches.map(renderOrgBranch).join('')}</div>
          <p class="sales-basis">${orgEditMode
            ? '수정 중에는 구성원을 세로로 펼쳐 보여 줍니다. 바꾼 직급은 이 브라우저에만 저장되는 초안이며 운영 DB에는 반영되지 않습니다.'
            : (canManageOrganization
              ? '조직도는 화면 폭에 맞춰 한눈에 들어오게 자동으로 조절됩니다. 직급을 바꾸려면 오른쪽 위 직급 수정을 누르세요. 부장 이상만 수정할 수 있습니다.'
              : '조직도는 화면 폭에 맞춰 한눈에 들어오게 자동으로 조절됩니다. 직급은 부장 이상만 수정할 수 있으며 현재 계정은 조회만 가능합니다.')}</p>
        </div>
      </section>
      ${renderOrgUnassigned()}
      <div class="module-security"><span>▣</span><span><strong>조직도와 권한은 분리해서 관리합니다</strong><br>조직도는 보고 체계와 소속을 보여주고, 급여·최종정산·세금 같은 민감자료는 별도 서버 권한으로 다시 확인합니다.</span></div>`;

    fitOrgTrees();
    loadOrgDirectory();
  }

  // ── 시트접수 ────────────────────────────────────────────────
  // 접수 초안은 계정별로 따로 담는다. 한 브라우저를 여러 사람이 써도 섞이지 않는다.
  // 미리보기로 다른 사람을 볼 때도 그 사람 몫으로 따로 담는다.
  function intakeStorageKey() {
    return `peakos.intakeDraft.${previewPersona || userDoc?.uid || 'anon'}`;
  }

  // 브라우저에만 있던 초안. 서버로 옮긴 뒤에는 마이그레이션 원본으로만 쓴다.
  function localIntakeDraft(key) {
    try {
      const saved = JSON.parse(localStorage.getItem(key || intakeStorageKey()) || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch (error) {
      return [];
    }
  }

  async function loadIntakeDraft() {
    if (previewPersona) {
      // 대표 계정이면 그 사람의 실제 접수를 서버에서 가져와 보여 준다.
      if (canPreviewRealData()) {
        try {
          const rows = await readOnlyApi(`/peakos/intake?owner=${encodeURIComponent(previewPersona)}`);
          intakeDraft = Array.isArray(rows) ? rows : [];
          return;
        } catch (error) {
          console.error('미리보기 접수 불러오기 실패:', error.message);
        }
      }
      // 볼 수 없는 사람이면 화면만 흉내내고 데이터는 비운다.
      intakeDraft = [];
      return;
    }
    try {
      const rows = await readOnlyApi('/peakos/intake');
      intakeDraft = Array.isArray(rows) ? rows : [];
    } catch (error) {
      console.error('접수 불러오기 실패:', error.message);
      intakeDraft = [];
      showToast('접수를 불러오지 못했습니다. 새로고침해 주세요.');
    }
  }

  async function loadBankMatchReviewRows() {
    if (previewPersona || !canReviewCreditRequests()) {
      bankMatchReviewRows = [];
      return;
    }
    const [rowsResult, bankStatusResult] = await Promise.allSettled([
      readOnlyApi('/peakos/intake?scope=all'),
      readOnlyApi('/peakos/bank/accounts'),
    ]);
    bankMatchReviewRows = rowsResult.status === 'fulfilled' && Array.isArray(rowsResult.value)
      ? rowsResult.value
      : [];
    bankData.autoReconciliationEnabled = bankStatusResult.status === 'fulfilled'
      && bankStatusResult.value?.autoReconciliationEnabled === true;
  }

  // 화면에서 바꾼 건을 서버에 반영한다. 미리보기 중에는 브라우저에만 남긴다.
  async function saveIntakeRows(rows) {
    if (previewPersona) {
      showToast(`${previewPersona} 계정 미리보기 중에는 저장되지 않습니다.`);
      return;
    }
    const list = (rows && rows.length ? rows : intakeDraft).filter(Boolean);
    if (!list.length) return;
    try {
      await callApi('POST', '/peakos/intake', { rows: list });
    } catch (error) {
      console.error('접수 저장 실패:', error.message);
      showToast(`저장하지 못했습니다. ${error.message}`);
    }
  }

  async function removeIntakeRow(id) {
    if (previewPersona) {
      showToast(`${previewPersona} 계정 미리보기 중에는 지울 수 없습니다.`);
      return;
    }
    try {
      await callApi('DELETE', `/peakos/intake/${encodeURIComponent(id)}`);
    } catch (error) {
      console.error('접수 삭제 실패:', error.message);
      showToast(`지우지 못했습니다. ${error.message}`);
    }
  }

  // 예전 호출부를 그대로 두기 위한 얇은 껍데기. 전체를 밀어 넣는다.
  function saveIntakeDraft() {
    saveIntakeRows(intakeDraft);
  }

  // 나중에 추가한 상품. 단가표는 회사 전체가 같이 쓰므로 계정별로 나누지 않는다.
  const CUSTOM_PRICE_KEY = 'peakos.customPrices';
  const PRICE_EDIT_KEY = 'peakos.priceOverrides';
  let customPrices = [];
  // 기본 단가표를 직접 고치지 않고 덮어쓸 값만 따로 둔다. '대|중|소' -> [회사원가, 영업자단가]
  let priceOverrides = {};

  function localCustomPrices() {
    try {
      const rows = JSON.parse(localStorage.getItem(CUSTOM_PRICE_KEY) || '[]');
      const edits = JSON.parse(localStorage.getItem(PRICE_EDIT_KEY) || '{}');
      return {
        rows: Array.isArray(rows) ? rows : [],
        edits: edits && typeof edits === 'object' ? edits : {}
      };
    } catch (error) {
      return { rows: [], edits: {} };
    }
  }

  // 단가표는 회사 공용이라 계정과 무관하게 서버에서 읽는다.
  // 단가표 전체를 서버에서 받는다. 회사 원가는 권한이 없으면 null 로 온다.
  async function loadCustomPrices() {
    try {
      const rows = await readOnlyApi('/peakos/prices');
      PRICE_TABLE = [];
      customPrices = [];
      priceOverrides = {};
      (Array.isArray(rows) ? rows : []).forEach(row => {
        const entry = [row.a, row.b, row.c, row.cost, row.unit];
        if (row.custom) customPrices.push(entry);
        else PRICE_TABLE.push(entry);
      });
    } catch (error) {
      console.error('단가표 불러오기 실패:', error.message);
      PRICE_TABLE = [];
      customPrices = [];
      priceOverrides = {};
      showToast('단가표를 불러오지 못했습니다. 새로고침해 주세요.');
    }
  }

  // 고친 한 건만 보낸다. 통째로 밀어 넣으면 남이 방금 고친 값을 덮는다.
  async function savePriceEntry(key, a, b, c, cost, unit, custom) {
    try {
      await callApi('PUT', '/peakos/prices', { key, a, b, c, cost, unit, custom });
    } catch (error) {
      console.error('단가 저장 실패:', error.message);
      showToast(`단가를 저장하지 못했습니다. ${error.message}`);
    }
  }

  async function removePriceEntry(key) {
    try {
      await callApi('DELETE', `/peakos/prices/${encodeURIComponent(key)}`);
    } catch (error) {
      console.error('단가 삭제 실패:', error.message);
      showToast(`되돌리지 못했습니다. ${error.message}`);
    }
  }

  function priceKey(row) {
    return `${row[0]}|${row[1]}|${row[2]}`;
  }

  // 기본 단가표 + 추가한 상품 + 고친 단가. 접수 화면과 단가표가 같은 목록을 본다.
  function priceRows() {
    const customKeys = new Set(customPrices.map(priceKey));
    return PRICE_TABLE.concat(customPrices).map(row => {
      row.custom = customKeys.has(priceKey(row));
      row.edited = Boolean(priceOverrides[priceKey(row)]);
      return row;
    });
  }

  function isCustomPrice(row) {
    return Boolean(row.custom);
  }

  function priceRow(a, b, c) {
    return priceRows().find(row => row[0] === a && row[1] === b && row[2] === c) || null;
  }

  function priceLevels(key, ...filters) {
    const index = ['a', 'b', 'c'].indexOf(key);
    return [...new Set(priceRows()
      .filter(row => filters.every((value, i) => !value || row[i] === value))
      .map(row => row[index]))];
  }

  // 회사 원가는 부장 이상만 본다. 지금 구글 정산서와 같은 경계.
  // 회사 원가는 직급이 아니라 지정된 사람만 본다. 직급 기준으로 두면
  // 지사 이사처럼 명단 밖의 사람이 열리고, 손명아 실장·전현우 팀장은 막힌다.
  function canSeeCompanyCost() {
    if (userDoc?.role === 'admin') return true;
    return FINAL_SETTLEMENT_VIEWERS.includes(String(userDoc?.name || '').trim());
  }

  // 볼 자격이 있어도 개인정산서에는 회사 원가를 띄우지 않는다.
  // 개인정산서는 누가 보든 영업자 단가 기준으로만 읽히게 한다.
  function showCompanyCost() {
    return intakeContext === 'final-settlement' && canSeeCompanyCost();
  }

  // 예약 단가 수정은 원래대로 부장 이상 직급 기준이다.
  function canEditReserveUnit() {
    return orgRankOrder(currentOrgRank()) <= ORG_RANK_MANAGE_FROM;
  }

  // 로그인 계정이 어느 지사인지. 조직도에 이름이 있으면 그것을 따르고,
  // 없으면 소속 그룹명으로 가른다.
  function currentBranchId() {
    const myName = String(userDoc?.name || '').trim();
    const mine = orgRoster().find(row => row.name === myName);
    if (mine) return mine.branch.id;
    const group = String(userDoc?.group_name || '');
    if (group.startsWith('대구')) return 'daegu';
    if (group.startsWith('전주')) return 'jeonju';
    return 'hq';
  }

  function currentBranchName() {
    const branch = ORG_STRUCTURE.find(item => item.id === currentBranchId());
    return branch ? branch.name : '본사';
  }

  // 정산서는 본사 기준으로 먼저 잡는다. 지사는 접수 경로와 상품이 달라
  // 별도 체계로 따로 만든다.
  function settlementAvailable() {
    return currentBranchId() === 'hq';
  }

  // 대표 마스터 계정(패션TV봉이)은 이름이 달라 role로도 확인한다.
  function canSeeFinalSettlement() {
    if (previewPersona && canPreviewRealData()) return true;
    if (userDoc?.role === 'admin') return true;
    return FINAL_SETTLEMENT_VIEWERS.includes(String(userDoc?.name || '').trim());
  }

  function canSeeFinalExecutionSettlement() {
    if (previewPersona) return false;
    return userDoc?.peakos_can_view_final_execution === true;
  }

  // 다른 사람 화면을 미리 볼 수 있는 사람. 미리보기 중에는 userDoc 이 바뀌므로
  // 실제 로그인 계정(realUserDoc)을 기준으로 판단한다.
  // 대표 계정. 미리보기로 누구의 접수든 볼 수 있다.
  const PREVIEW_MASTERS = ['패션TV봉이'];
  // 김대호·박종원도 미리보기로 실제 접수를 보지만 이 사람들 것은 못 본다.
  const PREVIEW_PROTECTED = ['김진봉', '패션TV봉이', '손명아'];

  function isPreviewMaster() {
    const real = realUserDoc || userDoc;
    return PREVIEW_MASTERS.includes(String(real?.name || '').trim());
  }

  // 미리보기에서 그 사람의 실제 접수까지 볼 수 있는지. 쓰기는 어느 경우든 막는다.
  function canPreviewRealData(persona = previewPersona) {
    if (!canPreviewPersona()) return false;
    if (isPreviewMaster()) return true;
    return !PREVIEW_PROTECTED.includes(String(persona || '').trim());
  }

  function canPreviewPersona() {
    const real = realUserDoc || userDoc;
    return ACCOUNT_PREVIEW_VIEWERS.includes(String(real?.name || '').trim());
  }

  function canSeeTeamSettlement() {
    if (userDoc?.role === 'admin') return true;
    return TEAM_SETTLEMENT_VIEWERS.includes(String(userDoc?.name || '').trim());
  }

  // 통장 원장은 승인·활성 직원이면 공개 3계좌를 읽을 수 있다. 이 값은
  // 서버의 UID/계정 상태 판정 결과만 신뢰하고 표시이름이나 admin으로 넓히지 않는다.
  function canSeeBankLedger() {
    if (previewPersona) return false;
    return userDoc?.peakos_can_read_bank === true;
  }

  function canReviewFinanceRequests() {
    if (previewPersona) return false;
    return userDoc?.peakos_can_review_finance === true;
  }

  function canSeeTaxPurchase() {
    if (previewPersona) return false;
    return userDoc?.peakos_can_view_tax_purchase === true;
  }

  function canUseFinanceRequests() {
    return !previewPersona && userDoc?.approved === true && userDoc?.is_active !== false;
  }

  function canSeeTaxBankingView(view) {
    if (view === 'bank') return canSeeBankLedger();
    if (PURCHASE_TAX_VIEWS.includes(view)) return canSeeTaxPurchase();
    return TAX_BANKING_PUBLIC_VIEWS.includes(view) && canUseFinanceRequests();
  }

  function canReviewCreditRequests() {
    if (previewPersona) return false;
    return CREDIT_REQUEST_REVIEWERS.includes(String(userDoc?.name || '').trim());
  }

  // 하위 계정 목록. 본사에서 자기를 뺀 나머지를 직급 순으로 보여 준다.
  function subordinateRoster() {
    const myName = String(userDoc?.name || '').trim();
    return orgRoster()
      .filter(row => row.branch.id === 'hq' && row.name !== myName && row.rank !== '대표')
      .sort((a, b) => orgRankOrder(orgRankOf(a)) - orgRankOrder(orgRankOf(b)));
  }

  function validDateKey(value) {
    const text = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
    const date = new Date(`${text}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : '';
  }

  function validMonthKey(value) {
    const text = String(value || '');
    if (!/^\d{4}-\d{2}$/.test(text)) return '';
    const month = Number(text.slice(5));
    return month >= 1 && month <= 12 ? text : '';
  }

  function monthPeriodBounds(monthValue) {
    const month = validMonthKey(monthValue);
    if (!month) return { from: '', to: '' };
    const year = Number(month.slice(0, 4));
    const monthNumber = Number(month.slice(5));
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
  }

  function financePeriodBounds() {
    if (financePeriodFilter.mode === 'month') return monthPeriodBounds(financePeriodFilter.month);
    if (financePeriodFilter.mode === 'range') {
      return {
        from: validDateKey(financePeriodFilter.from),
        to: validDateKey(financePeriodFilter.to)
      };
    }
    return { from: '', to: '' };
  }

  function nextDateKey(value) {
    const dateKey = validDateKey(value);
    if (!dateKey) return '';
    const date = new Date(`${dateKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  }

  function inFinancePeriod(value) {
    const date = validDateKey(String(value || '').slice(0, 10));
    if (!date) return false;
    const { from, to } = financePeriodBounds();
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  }

  function financePeriodLabel() {
    const { from, to } = financePeriodBounds();
    if (financePeriodFilter.mode === 'month' && from) {
      return `${from.slice(0, 4)}년 ${Number(from.slice(5, 7))}월`;
    }
    if (financePeriodFilter.mode === 'range') {
      if (from && to) return `${from} ~ ${to}`;
      if (from) return `${from} 이후`;
      if (to) return `${to} 이전`;
      return '기간을 선택해 주세요';
    }
    return '전체 기간';
  }

  function renderFinancePeriodFilter(view, note = '') {
    if (!FINANCE_PERIOD_VIEWS.includes(view)) return '';
    const state = financePeriodFilter;
    const modeButton = (mode, label) => `<button class="finance-period-mode ${state.mode === mode ? 'active' : ''}" type="button" data-finance-period-mode="${mode}" aria-pressed="${state.mode === mode ? 'true' : 'false'}">${label}</button>`;
    return `<div class="finance-period-filter" data-finance-period-filter="${esc(view)}">
      <div class="finance-period-modes" role="group" aria-label="조회 기간 방식">
        ${modeButton('all', '전체')}${modeButton('month', '월별')}${modeButton('range', '기간별')}
      </div>
      ${state.mode === 'month' ? `<label class="finance-period-control"><span>조회 월</span><input type="month" data-finance-period-month value="${esc(state.month)}" aria-label="조회 월"></label>` : ''}
      ${state.mode === 'range' ? `<label class="finance-period-control finance-period-range"><span>조회 기간</span><span><input type="date" data-finance-period-from value="${esc(state.from)}" aria-label="조회 시작일"><em>~</em><input type="date" data-finance-period-to value="${esc(state.to)}" aria-label="조회 종료일"></span></label>` : ''}
      <span class="finance-period-result"><strong>${esc(financePeriodLabel())}</strong>${note ? `<small>${esc(note)}</small>` : ''}</span>
    </div>`;
  }

  function bankPeriodQuery(accountId = '', page = bankPage) {
    const params = new URLSearchParams({ page: String(Math.max(1, Number(page) || 1)), limit: '100' });
    if (accountId) params.set('accountId', accountId);
    const { from, to } = financePeriodBounds();
    if (from) params.set('from', `${from}T00:00:00+09:00`);
    if (to) params.set('to', `${nextDateKey(to)}T00:00:00+09:00`);
    return params.toString();
  }

  // 개인정산서에 올라가는 건. 최종정산서에서만 적는 건은 빠진다.
  function personalRows() {
    return intakeDraft.filter(row => !row.finalOnly);
  }

  // 조회 조건에 맞는 접수만 걸러 낸다.
  function filteredIntake() {
    const f = intakeFilter;
    return personalRows().filter(row => {
      if (!inFinancePeriod(row.date)) return false;
      if (f.client && row.client !== f.client) return false;
      if (f.product && row.a !== f.product) return false;
      if (f.paid === 'unpaid' && paidStateOf(row) !== 'none') return false;
      if (f.paid === 'paid' && paidStateOf(row) === 'none') return false;
      if (f.paid && f.paid !== 'unpaid' && f.paid !== 'paid' && paidStateOf(row) !== f.paid) return false;
      return true;
    });
  }

  function intakeFilterActive() {
    return Object.values(intakeFilter).some(Boolean);
  }

  function intakeQueryActive() {
    return financePeriodFilter.mode !== 'all' || intakeFilterActive();
  }

  function renderIntakeFilter() {
    const clients = [...new Set(personalRows().map(row => row.client).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
    const products = [...new Set(personalRows().map(row => row.a).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
    const option = (value, label, selected) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;

    return `<div class="ledger-filter">
      <label class="ledger-filter-field">
        <span>거래처</span>
        <select data-ledger-filter="client">
          ${option('', '전체', intakeFilter.client)}
          ${clients.map(name => option(name, name, intakeFilter.client)).join('')}
        </select>
      </label>
      <label class="ledger-filter-field">
        <span>상품</span>
        <select data-ledger-filter="product">
          ${option('', '전체', intakeFilter.product)}
          ${products.map(name => option(name, name, intakeFilter.product)).join('')}
        </select>
      </label>
      <label class="ledger-filter-field">
        <span>입금</span>
        <select data-ledger-filter="paid">
          ${option('', '전체', intakeFilter.paid)}
          ${option('paid', '입금된 건', intakeFilter.paid)}
          ${option('unpaid', '미입금', intakeFilter.paid)}
          ${option('partial', '부분입금', intakeFilter.paid)}
          ${option('wrong', '오입금', intakeFilter.paid)}
        </select>
      </label>
      ${intakeFilterActive() ? '<button class="module-action" type="button" data-ledger-filter-reset>조건 해제</button>' : ''}
    </div>`;
  }

  function intakeRowsByDate() {
    const groups = new Map();
    [...filteredIntake()]
      .sort((x, y) => String(y.date).localeCompare(String(x.date)))
      .forEach(row => {
        if (!groups.has(row.date)) groups.set(row.date, []);
        groups.get(row.date).push(row);
      });
    return [...groups.entries()];
  }

  // ── 접수 구분 ────────────────────────────────────────────────
  // 일반 접수 외에 선입금(예약최초건), 그 예약을 쓰는 작업, 환불이 있다.
  const INTAKE_KINDS = {
    normal: { label: '당일접수', badge: '' },
    reserve: { label: '예약최초건', badge: 'reserve' },
    use: { label: '예약건 작업', badge: 'use' },
    refund: { label: '환불', badge: 'refund' }
  };

  function kindOf(row) {
    return INTAKE_KINDS[row.kind] ? row.kind : 'normal';
  }

  // 환불과 예약 차감은 부호를 뒤집어 쓴다.
  function signOf(row) {
    return kindOf(row) === 'refund' ? -1 : 1;
  }

  // 예약 차감과 환불은 같은 화면에서 넣은 건끼리만 묶는다.
  // 최종정산서 전용 건과 개인정산서 건이 섞이면 어느 쪽 숫자도 맞지 않는다.
  function contextRows() {
    return intakeDraft.filter(row => Boolean(row.finalOnly) === (intakeContext === 'final-settlement'));
  }

  function reservationRows() {
    return contextRows().filter(row => kindOf(row) === 'reserve');
  }

  // 입금이 정확히 확인된 예약만 차감할 수 있다.
  function usableReservations() {
    return reservationRows().filter(row => paidStateOf(row) === 'paid');
  }

  // 예약최초건에서 이미 쓴 수량과 금액
  function reserveUsed(reserveId) {
    return intakeDraft
      .filter(row => kindOf(row) === 'use' && row.refOf === reserveId)
      .reduce((sum, row) => {
        // 예약건 작업을 되돌리면 돈은 그대로 맡아 둔 채 예약 잔여로 돌아온다.
        // 나중에 재접수할 몫이므로 업체에 돌려주는 환불과는 다르다.
        // 음수 수량으로 직접 되돌린 건도 같은 방식으로 잔여에 반영된다.
        const net = (Number(row.qty) || 0) - refundedQty(row.id);
        sum.qty += net;
        sum.amount += (Number(row.sell) || 0) * net;
        return sum;
      }, { qty: 0, amount: 0 });
  }

  // 정산서에 찍히는 이름. 환불은 대상이 예약건 작업이면 예약건환불로 나눈다.
  function kindLabel(row) {
    const kind = kindOf(row);
    if (kind === 'refund' && isReserveRefund(row)) return '예약건환불';
    return INTAKE_KINDS[kind].label;
  }

  // 접수담당자 — 실제로 접수를 넣은 사람(접수자)과 별개로,
  // 이 건의 담당이 누구인지 최종정산서에만 표기한다.
  const NO_MANAGER = '담당 없음';

  function managerRoster() {
    return orgRoster()
      .filter(row => row.branch.id === 'hq' && row.rank !== '대표')
      .sort((a, b) => orgRankOrder(orgRankOf(a)) - orgRankOrder(orgRankOf(b)))
      .map(row => row.name);
  }

  function managerOf(row) {
    return String(row.manager || '').trim() || NO_MANAGER;
  }

  function defaultSupplier(b, c) {
    return SUPPLIER_BY_PRODUCT[`${b}|${c}`] || '';
  }

  function supplierOf(row) {
    return String(row.supplier || defaultSupplier(row.b, row.c) || '미지정').trim();
  }

  // 최종정산서에 올라가는 건 — 예약최초건은 아직 일한 게 아니라 빠진다.
  function finalSettlementRows() {
    return intakeDraft.filter(row => kindOf(row) !== 'reserve');
  }

  // 예약건 작업을 되돌린 환불인지 — 이 경우 돈이 나가지 않는다.
  function isReserveRefund(row) {
    if (kindOf(row) !== 'refund') return false;
    const target = intakeDraft.find(item => item.id === row.refOf);
    return Boolean(target) && kindOf(target) === 'use';
  }

  function reserveRemaining(reserve) {
    const used = reserveUsed(reserve.id);
    const paid = Number(reserve.paidAmount) || 0;
    // 되돌린 수량이 쌓여도 처음 받은 예약보다 잔여가 많아질 수는 없다.
    return {
      qty: Math.min(Number(reserve.qty) || 0, Math.max(0, (Number(reserve.qty) || 0) - used.qty)),
      amount: Math.min(paid, Math.max(0, paid - used.amount))
    };
  }

  // 환불 가능한 접수와 이미 환불된 수량
  function refundableRows() {
    return contextRows().filter(row => ['normal', 'use'].includes(kindOf(row)));
  }

  function refundedQty(rowId) {
    return intakeDraft
      .filter(row => kindOf(row) === 'refund' && row.refOf === rowId)
      .reduce((sum, row) => sum + (Number(row.qty) || 0), 0);
  }

  function refundableQty(row) {
    return Math.max(0, (Number(row.qty) || 0) - refundedQty(row.id));
  }

  // 예약은 업체명과 메모로 구분한다. 같은 업체라도 메모가 다르면 다른 예약이다.
  function reserveKey(row) {
    const memo = String(row.memo || '').trim();
    return `${row.client || '업체 미입력'}${memo ? ` - ${memo}` : ''}`;
  }

  function intakeLabel(row) {
    return `${row.client || '업체 미입력'} · ${row.a} › ${row.c}`;
  }

  // ── 입금 확인 ────────────────────────────────────────────────
  const PAID_STATES = {
    none: { label: '미입금', tone: 'wait' },
    paid: { label: '입금', tone: 'ok' },
    partial: { label: '부분입금', tone: 'wait' },
    wrong: { label: '오입금', tone: 'hold' }
  };

  function paidStateOf(row) {
    return PAID_STATES[row.paid] ? row.paid : 'none';
  }

  function rowSales(row) {
    return (Number(row.sell) || 0) * (Number(row.qty) || 0);
  }

  // 입금액이 판매액과 다르면 상태를 자동으로 맞춘다.
  function resolvePaidState(row, amount) {
    const sales = rowSales(row);
    if (!amount) return 'none';
    if (amount === sales) return 'paid';
    return amount < sales ? 'partial' : 'wrong';
  }

  function intakeTotals(rows) {
    return rows.reduce((sum, row) => {
      const kind = kindOf(row);
      const sign = signOf(row);
      const supply = (Number(row.unit) || 0) * (Number(row.qty) || 0) * sign;
      const sales = (Number(row.sell) || 0) * (Number(row.qty) || 0) * sign;
      const cost = row.cost === null || row.cost === undefined
        ? null
        : Number(row.cost) * (Number(row.qty) || 0) * sign;

      // 예약최초건은 아직 일한 게 아니라 매출로 잡지 않는다. 받은 돈만 예약금으로 센다.
      if (kind === 'reserve') {
        sum.reserve += reserveRemaining(row).amount;
        return sum;
      }

      sum.supply += supply;
      sum.sales += sales;
      sum.profit += sales - supply;
      if (cost !== null) sum.cost += cost;
      // 예약건 작업은 예약금에서 충당되므로 그만큼 이미 받은 것으로 본다.
      // 예약금에서 충당된 건은 그만큼 이미 받은 것으로 보고, 되돌릴 때도 같이 뺀다.
      sum.paid += (kind === 'use' || isReserveRefund(row))
        ? sales
        : (Number(row.paidAmount) || 0) * sign;
      return sum;
    }, { supply: 0, sales: 0, profit: 0, cost: 0, paid: 0, reserve: 0 });
  }

  // 현재 입력값으로 계산 칸만 다시 만든다. 글자를 칠 때마다 화면 전체를
  // 다시 그리면 커서가 맨 앞으로 튀므로 이 부분만 갈아 끼운다.
  function intakeCalcMarkup() {
    const form = intakeForm;
    const row = priceRow(form.a, form.b, form.c);
    const variable = Boolean(row) && row[4] === null;
    const unit = Number(variable ? form.unit : (row ? row[4] : 0)) || 0;
    const qty = Number(form.qty) || 0;
    const sell = Number(form.sell) || 0;
    const supply = unit * qty;
    const sales = sell * qty;
    return `
      <article><span>영업자 공급가액</span><strong>${supply ? esc(supply.toLocaleString('ko-KR')) : '—'}</strong></article>
      <article><span>판매액 (매출)</span><strong>${sales ? esc(sales.toLocaleString('ko-KR')) : '—'}</strong></article>
      <article class="profit"><span>영업이익</span><strong>${unit && qty ? esc((sales - supply).toLocaleString('ko-KR')) : '—'}</strong></article>
      ${showCompanyCost()
        ? `<article><span>회사 원가</span><strong>${row && row[3] !== null && qty ? esc((row[3] * qty).toLocaleString('ko-KR')) : '—'}</strong></article>`
        : '<article class="masked"><span>회사 원가</span><strong>표시 안 함</strong></article>'}`;
  }

  function updateIntakeCalc() {
    const box = moduleView.querySelector('.intake-calc');
    if (box) box.innerHTML = intakeCalcMarkup();
  }

  function renderIntakeForm() {
    const form = intakeForm;

    // 예약건 작업은 예약최초건의, 환불은 원래 접수건의 조건을 그대로 따른다.
    // 업체명·메모·상품·판매단가를 원본에서 가져와 잠가 두면 서로 어긋날 일이 없다.
    const source = form.kind === 'use'
      ? usableReservations().find(item => item.id === form.refOf)
      : (form.kind === 'refund'
        ? refundableRows().find(item => item.id === form.refOf)
        : null);
    if (source) {
      form.client = source.client || '';
      form.expectedPayer = source.expectedPayer || source.client || '';
      form.memo = source.memo || '';
      form.a = source.a;
      form.b = source.b;
      form.c = source.c;
      form.sell = String(source.sell ?? '');
      if (!form.unit) form.unit = String(source.unit ?? '');
    }
    // 영업자 단가는 나중에 바뀔 수 있어 부장 이상만 고칠 수 있다.
    const lockBase = Boolean(source);
    const unitEditable = !lockBase || canEditReserveUnit();
    // 공급처는 상품에서 자동으로 붙되 직접 바꿀 수 있다. 되돌림·환불은 원본을 따른다.
    const suggested = defaultSupplier(form.b, form.c);
    if (source) form.supplier = source.supplier || '';
    const supplier = form.supplier || suggested;

    const majors = priceLevels('a');
    if (!form.a || !majors.includes(form.a)) form.a = majors[0] || '';
    const mids = priceLevels('b', form.a);
    if (!form.b || !mids.includes(form.b)) form.b = mids[0] || '';
    const minors = priceLevels('c', form.a, form.b);
    if (!form.c || !minors.includes(form.c)) form.c = minors[0] || '';

    const row = priceRow(form.a, form.b, form.c);
    const variable = Boolean(row) && row[4] === null;
    const unit = lockBase ? form.unit : (variable ? form.unit : (row ? row[4] : ''));
    const qty = Number(form.qty) || 0;
    const sell = Number(form.sell) || 0;
    const supply = (Number(unit) || 0) * qty;
    const sales = sell * qty;

    const option = (value, selected) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(value)}</option>`;

    // 예약건 작업과 환불은 어느 건에서 빼는지 골라야 한다.
    let targetPicker = '';
    let limitQty = null;
    if (form.kind === 'use') {
      const list = usableReservations();
      const waiting = reservationRows().length - list.length;
      const picked = list.find(item => item.id === form.refOf);
      if (picked) limitQty = reserveRemaining(picked).qty;
      const emptyLabel = waiting > 0
        ? `입금 확인된 예약최초건이 없습니다 (입금 대기 ${waiting}건)`
        : '등록된 예약최초건이 없습니다';
      targetPicker = `<div class="intake-target">
        <label class="intake-field wide">
          <span>차감할 예약최초건</span>
          <select data-intake="refOf">
            <option value="">${list.length ? '선택하세요' : emptyLabel}</option>
            ${list.map(item => {
              const left = reserveRemaining(item);
              return `<option value="${esc(item.id)}" ${item.id === form.refOf ? 'selected' : ''}>${esc(reserveKey(item))} · ${esc(item.c)} · 잔여 ${esc(String(left.qty))}개 / ${esc(left.amount.toLocaleString('ko-KR'))}원</option>`;
            }).join('')}
          </select>
        </label>
        ${picked
          ? `<p class="intake-limit">잔여 수량 <strong>${esc(String(limitQty))}</strong>개 · 잔여 금액 <strong>${esc(reserveRemaining(picked).amount.toLocaleString('ko-KR'))}</strong>원을 넘을 수 없습니다. 되돌릴 때는 수량을 <strong>마이너스</strong>로 넣으면 공급사 원가까지 함께 빠집니다.</p>`
          : (waiting > 0 ? `<p class="intake-limit warn">예약최초건에 <strong>입금 확인</strong>이 된 뒤에야 예약건 작업으로 넘길 수 있습니다. 현재 입금 대기 <strong>${esc(String(waiting))}</strong>건.</p>` : '')}
      </div>`;
    } else if (form.kind === 'refund') {
      const list = refundableRows().filter(item => refundableQty(item) > 0);
      const picked = list.find(item => item.id === form.refOf);
      if (picked) limitQty = refundableQty(picked);
      targetPicker = `<div class="intake-target">
        <label class="intake-field wide">
          <span>환불할 접수건</span>
          <select data-intake="refOf">
            <option value="">${list.length ? '선택하세요' : '환불할 수 있는 접수가 없습니다'}</option>
            ${list.map(item => `<option value="${esc(item.id)}" ${item.id === form.refOf ? 'selected' : ''}>${esc(item.date)} · ${esc(intakeLabel(item))} · 환불가능 ${esc(String(refundableQty(item)))}개</option>`).join('')}
          </select>
        </label>
        ${picked ? `<p class="intake-limit">환불 가능 수량 <strong>${esc(String(limitQty))}</strong>개를 넘을 수 없습니다. 금액은 마이너스로 잡힙니다.${
          kindOf(picked) === 'use' ? ' 예약건 작업이라 돈은 나가지 않고 <strong>예약 잔여로 되돌아갑니다.</strong>' : ''
        }</p>` : ''}
      </div>`;
    }

    const finalMode = intakeContext === 'final-settlement';
    return `<section class="module-section intake-section ${intakeOpen ? 'open' : 'closed'}">
      <div class="module-section-head">
        <span><strong>${finalMode ? '최종정산서 접수' : '상품 접수'}</strong><small>${finalMode
          ? '여기서 넣은 건은 최종정산서에만 올라가고 개인정산서에는 나오지 않습니다'
          : '시트접수 건을 등록합니다. 분류를 고르면 영업자 단가가 자동으로 붙습니다'}</small></span>
        <span class="intake-head-right">
          <span class="module-chip ${finalMode ? 'restricted' : 'live'}">${finalMode ? '최종정산서 전용' : '시트접수'}</span>
          <button class="module-action" type="button" data-price-table>단가표</button>
          <button class="module-action primary intake-toggle" type="button" data-intake-toggle aria-expanded="${intakeOpen ? 'true' : 'false'}">${intakeOpen ? '접기' : '＋ 접수 등록'}</button>
        </span>
      </div>
      <div class="module-section-body" ${intakeOpen ? '' : 'hidden'}>
        <div class="intake-kind">
          ${Object.entries(INTAKE_KINDS).map(([key, info]) => `<button class="intake-kind-btn ${form.kind === key ? 'active' : ''}" type="button" data-intake-kind="${esc(key)}">${esc(info.label)}</button>`).join('')}
        </div>
        ${targetPicker}
        <div class="intake-form">
          <label class="intake-field">
            <span>일자</span>
            <input type="date" data-intake="date" value="${esc(form.date || localDateKey(new Date()))}">
          </label>
          <label class="intake-field ${lockBase ? 'auto' : ''}">
            <span>업체명</span>
            <input type="text" data-intake="client" value="${esc(form.client)}" placeholder="업체명 입력" ${lockBase ? 'readonly' : ''}>
          </label>
          ${['normal', 'reserve'].includes(form.kind) ? `<label class="intake-field ${lockBase ? 'auto' : ''}">
            <span>예상 입금자명</span>
            <input type="text" data-intake="expectedPayer" value="${esc(form.expectedPayer || '')}" placeholder="비우면 업체명과 동일" ${lockBase ? 'readonly' : ''}>
            <small>통장 표기와 정확히 같을 때만 자동 확인</small>
          </label>` : ''}
          <label class="intake-field ${lockBase ? 'auto' : ''}">
            <span>대분류</span>
            <select data-intake="a" ${lockBase ? 'disabled' : ''}>${majors.map(v => option(v, form.a)).join('')}</select>
          </label>
          <label class="intake-field ${lockBase ? 'auto' : ''}">
            <span>중분류</span>
            <select data-intake="b" ${lockBase ? 'disabled' : ''}>${mids.map(v => option(v, form.b)).join('')}</select>
          </label>
          <label class="intake-field ${lockBase ? 'auto' : ''}">
            <span>소분류</span>
            <select data-intake="c" ${lockBase ? 'disabled' : ''}>${minors.map(v => option(v, form.c)).join('')}</select>
          </label>
          <label class="intake-field">
            <span>접수담당자</span>
            <select data-intake="manager">
              ${[''].concat(managerRoster()).map(v => `<option value="${esc(v)}" ${v === (form.manager || '') ? 'selected' : ''}>${esc(v || NO_MANAGER)}</option>`).join('')}
            </select>
            <small>최종정산서에만 반영</small>
          </label>
          <label class="intake-field ${lockBase ? 'auto' : ''}">
            <span>공급처</span>
            <select data-intake="supplier" ${lockBase ? 'disabled' : ''}>
              ${[''].concat(SUPPLIERS).map(v => `<option value="${esc(v)}" ${v === supplier ? 'selected' : ''}>${esc(v || '미지정')}</option>`).join('')}
            </select>
            ${lockBase ? '' : `<small>${suggested ? `기본 ${esc(suggested)}` : '상품을 고르면 자동'}</small>`}
          </label>
          ${variable && showCompanyCost() ? `<label class="intake-field ${form.cost ? '' : 'need'}">
            <span>회사 원가</span>
            <input type="number" min="0" data-intake="cost" value="${esc(form.cost ?? '')}" placeholder="직접 입력">
            <small>${form.cost ? '상시변동 · 직접 입력' : '상시변동 · 입력 필요'}</small>
          </label>` : ''}
          <label class="intake-field ${(lockBase ? !unitEditable : !variable) ? 'auto' : ''}">
            <span>영업자 단가</span>
            <input type="number" data-intake="unit" value="${esc(unit === '' || unit === null ? '' : unit)}"
              ${(lockBase ? !unitEditable : !variable) ? 'readonly' : 'placeholder="직접 입력"'}>
            ${lockBase ? '' : `<small>${variable ? '상시변동 상품 · 직접 입력' : '단가표에서 자동'}</small>`}
          </label>
          <label class="intake-field">
            <span>수량${limitQty === null ? '' : ` <em class="intake-cap">최대 ${esc(String(limitQty))}</em>`}</span>
            <input type="number" ${form.kind === 'reserve' || form.kind === 'refund' ? 'min="1"' : ''} ${limitQty === null ? '' : `max="${esc(String(limitQty))}"`} data-intake="qty" value="${esc(form.qty)}" placeholder="0">
          </label>
          <label class="intake-field ${lockBase ? 'auto' : ''}">
            <span>판매 단가</span>
            <input type="number" min="0" data-intake="sell" value="${esc(form.sell)}" placeholder="거래처 판매가" ${lockBase ? 'readonly' : ''}>
            ${lockBase ? `<small>${form.kind === 'refund' ? '원접수 단가 고정' : '예약 단가 고정'}</small>` : ''}
          </label>
          <label class="intake-field wide ${lockBase ? 'auto' : ''}">
            <span>접수 특이사항${lockBase ? ` <em class="intake-cap">${form.kind === 'refund' ? '원접수와 동일' : '예약과 동일'}</em>` : ''}</span>
            <input type="text" data-intake="memo" value="${esc(form.memo)}" placeholder="선택 입력 · 예약건, 재작업 등" ${lockBase ? 'readonly' : ''}>
          </label>
        </div>

        <div class="intake-calc">${intakeCalcMarkup()}</div>

        <div class="intake-actions">
          <p class="sales-basis">${finalMode
            ? '최종정산서에만 올라갑니다. 각 영업자의 개인정산서에는 나오지 않습니다. 이 브라우저에만 저장되는 초안입니다.'
            : '등록한 건은 이 브라우저에만 저장되는 초안이며 운영 DB에는 쓰지 않습니다.'}</p>
          <button class="module-action primary" type="button" data-intake-add>접수 등록</button>
        </div>
      </div>
    </section>`;
  }

  function pickBarMarkup() {
    if (!intakeSelection.length) return '';
    return `<div class="pick-bar">
      <span><strong>${esc(String(intakeSelection.length))}건</strong> 선택됨 · 한 번에 입금 처리하면 판매액 비율로 나눠 담습니다</span>
      <span class="pick-bar-actions">
        <button class="module-action" type="button" data-paid-clear-pick>선택 해제</button>
        <button class="module-action" type="button" data-estimate-pick>선택 건 정산서</button>
        <button class="module-action primary" type="button" data-paid-bulk>묶어서 입금 확인</button>
      </span>
    </div>`;
  }

  // 체크박스마다 전체를 다시 그리면 무겁고 포커스가 튄다. 선택 바와
  // 행 표시만 갈아 끼운다.
  function refreshPickBar() {
    const slot = moduleView.querySelector('.pick-bar-slot');
    if (!slot) return;
    slot.innerHTML = pickBarMarkup();
    moduleView.querySelectorAll('[data-intake-pick]').forEach(box => {
      box.closest('tr')?.classList.toggle('picked', intakeSelection.includes(box.dataset.intakePick));
    });
    slot.querySelector('[data-paid-bulk]')?.addEventListener('click', () => openPaidDialog(intakeSelection));
    slot.querySelector('[data-estimate-pick]')?.addEventListener('click', () => {
      const picked = personalRows().filter(row => intakeSelection.includes(row.id));
      const clients = [...new Set(picked.map(row => row.client || '업체 미입력'))];
      // 정산서는 한 업체 앞으로 나가는 문서라 여러 업체를 섞을 수 없다.
      if (clients.length > 1) {
        showToast(`거래처가 ${clients.length}곳(${clients.join(', ')})이라 한 장으로 낼 수 없습니다.`);
        return;
      }
      openEstimateDialog(clients[0] || '', picked);
    });
    slot.querySelector('[data-paid-clear-pick]')?.addEventListener('click', () => {
      intakeSelection = [];
      moduleView.querySelectorAll('[data-intake-pick]').forEach(box => { box.checked = false; });
      refreshPickBar();
    });
  }

  function renderPaidCell(row) {
    const state = paidStateOf(row);
    const info = PAID_STATES[state];
    const amount = Number(row.paidAmount) || 0;
    return `<button class="paid-chip ${esc(info.tone)}" type="button" data-paid-open="${esc(row.id)}"
      aria-label="${esc(row.client || '')} 입금 확인">
      <span>${esc(info.label)}</span>
      ${amount ? `<small>${esc(amount.toLocaleString('ko-KR'))}</small>` : ''}
      ${row.paidAuto ? '<em>자동</em>' : ''}
    </button>`;
  }

  // 입금 확인 창. 여러 건을 골랐으면 총 입금액을 판매액 비율로 나눠 담는다.
  function openPaidDialog(ids) {
    const visibleIds = activeView === 'settlement'
      ? new Set(filteredIntake().map(row => row.id))
      : activeView === 'deposit-check'
        ? new Set(depositRows().map(row => row.id))
        : null;
    const rows = intakeDraft.filter(row => ids.includes(row.id) && (!visibleIds || visibleIds.has(row.id)));
    if (!rows.length) return;
    const totalSales = rows.reduce((sum, row) => sum + rowSales(row), 0);
    const already = rows.reduce((sum, row) => sum + (Number(row.paidAmount) || 0), 0);
    const single = rows.length === 1;

    openDetailModal('입금 확인', `
      <p class="paid-modal-sub">${single
        ? `${esc(rows[0].client || '업체 미입력')} · ${esc(rows[0].a)} › ${esc(rows[0].c)}`
        : `${esc(String(rows.length))}건 묶음 · ${esc(rows.map(r => r.client || '업체 미입력').filter((v, i, arr) => arr.indexOf(v) === i).join(', '))}`}</p>

      <div class="paid-summary">
        <article><span>판매액 합계</span><strong>${esc(totalSales.toLocaleString('ko-KR'))}</strong></article>
        <article><span>기존 입금액</span><strong>${esc(already.toLocaleString('ko-KR'))}</strong></article>
      </div>

      <div class="paid-field">
        <label class="paid-label" for="paidAmount">입금액</label>
        <input class="paid-input" id="paidAmount" type="number" min="0" value="${esc(String(totalSales))}">
        <small class="paid-hint">통장에 찍힌 금액을 넣으세요. 판매액과 다르면 부분입금·오입금으로 잡힙니다.</small>
      </div>
      <div class="paid-field">
        <label class="paid-label" for="paidPayer">실제 입금자명</label>
        <input class="paid-input" id="paidPayer" type="text" value="${esc(rows[0].payer || rows[0].client || '')}" placeholder="통장에 찍힌 이름">
      </div>
      <div class="paid-field">
        <label class="paid-label" for="paidDate">입금일</label>
        <input class="paid-input" id="paidDate" type="date" value="${esc(rows[0].paidDate || localDateKey(new Date()))}">
      </div>
      <div class="paid-field">
        <label class="paid-label" for="paidMemo">입금 특이사항 <em class="paid-required">필수</em></label>
        <input class="paid-input" id="paidMemo" type="text" value="${esc(rows[0].paidMemo || '')}" placeholder="어느 통장에 어떻게 들어왔는지 적어 주세요">
      </div>

      ${single ? '' : '<p class="paid-hint">묶음은 판매액 비율로 나눠 담습니다.</p>'}

      <div class="paid-actions">
        <button class="module-action" type="button" data-paid-cancel>취소</button>
        <button class="module-action primary" type="button" data-paid-save>${already || !totalSales ? '입금내용 수정' : '입금확인'}</button>
      </div>`, { locked: true });

    const dialog = document.getElementById('readonlyModalBody');

    const MEMO_MIN = 8;
    const memoInput = document.getElementById('paidMemo');
    const amountInput = document.getElementById('paidAmount');
    const saveButton = dialog.querySelector('[data-paid-save]');

    // 0원이면 입금을 확인하는 게 아니라 내용을 고치는 것이다.
    function syncSaveLabel() {
      const amount = Number(amountInput.value) || 0;
      saveButton.textContent = (already || !amount) ? '입금내용 수정' : '입금확인';
    }

    amountInput.addEventListener('input', syncSaveLabel);
    syncSaveLabel();

    dialog.querySelector('[data-paid-cancel]').addEventListener('click', closeDetailModal);

    dialog.querySelector('[data-paid-save]').addEventListener('click', () => {
      if (memoInput.value.trim().length < MEMO_MIN) {
        memoInput.focus();
        showToast(`입금 특이사항을 ${MEMO_MIN}자 이상 적어 주세요.`);
        return;
      }
      const amount = Number(document.getElementById('paidAmount').value) || 0;
      const payer = document.getElementById('paidPayer').value.trim();
      const paidDate = document.getElementById('paidDate').value;
      const paidMemo = memoInput.value.trim();

      let left = amount;
      rows.forEach((row, index) => {
        const share = index === rows.length - 1
          ? left
          : (totalSales ? Math.round(amount * (rowSales(row) / totalSales)) : 0);
        left -= share;
        row.paidAmount = share;
        row.paid = resolvePaidState(row, share);
        row.payer = payer;
        row.paidDate = paidDate;
        row.paidMemo = paidMemo;
        row.paidAuto = false;
      });
      saveIntakeDraft();
      intakeSelection = [];
      closeDetailModal();
      renderPlannedModule(intakeContext);
      showToast(`입금 ${amount.toLocaleString('ko-KR')}원을 ${rows.length}건에 반영했습니다.`);
    });
  }

  // 담당자 지정 — 접수가 많아 한 건씩 고르기 어려우니 기간으로 묶어 배정한다.
  function openAssignDialog() {
    const today = localDateKey(new Date());
    const from = finalFilter.from || '';
    const to = finalFilter.to || '';
    const inRange = (row, a, b) => (!a || String(row.date) >= a) && (!b || String(row.date) <= b);
    const rows = finalSettlementRows();
    const majors = [...new Set(rows.map(row => row.a).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));

    openDetailModal('접수담당자 지정', `
      <p class="paid-hint">고른 기간의 접수에 담당자를 한 번에 배정합니다. 이미 담당자가 있는 건도 덮어씁니다.</p>

      <div class="paid-field">
        <label class="paid-label" for="assignFrom">적용 기간</label>
        <span class="ledger-filter-range">
          <input class="paid-input" id="assignFrom" type="date" value="${esc(from)}" aria-label="시작일">
          <em>~</em>
          <input class="paid-input" id="assignTo" type="date" value="${esc(to)}" aria-label="종료일">
        </span>
        <small class="paid-hint">비워 두면 전체 기간입니다. 하루만 지정하려면 같은 날짜를 양쪽에 넣으세요.</small>
      </div>

      <div class="paid-field">
        <label class="paid-label" for="assignMajor">상품</label>
        <span class="ledger-filter-range">
          <select class="paid-input" id="assignMajor" aria-label="대분류">
            <option value="">대분류 전체</option>
            ${majors.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}
          </select>
          <select class="paid-input" id="assignMinor" aria-label="소분류">
            <option value="">소분류 전체</option>
          </select>
        </span>
        <small class="paid-hint">담당이 상품별로 갈리면 여기서 좁히세요.</small>
      </div>

      <div class="paid-field">
        <label class="paid-label" for="assignManager">담당자</label>
        <select class="paid-input" id="assignManager">
          ${[''].concat(managerRoster()).map(v => `<option value="${esc(v)}">${esc(v || NO_MANAGER)}</option>`).join('')}
        </select>
      </div>

      <div class="assign-preview" id="assignPreview"></div>

      <div class="paid-actions">
        <button class="module-action" type="button" data-assign-cancel>취소</button>
        <button class="module-action primary" type="button" data-assign-save>배정하기</button>
      </div>`, { locked: true });

    const dialog = document.getElementById('readonlyModalBody');
    const fromInput = document.getElementById('assignFrom');
    const toInput = document.getElementById('assignTo');
    const managerInput = document.getElementById('assignManager');
    const majorInput = document.getElementById('assignMajor');
    const minorInput = document.getElementById('assignMinor');
    const preview = document.getElementById('assignPreview');
    const saveButton = dialog.querySelector('[data-assign-save]');

    function targets() {
      return rows.filter(row => inRange(row, fromInput.value, toInput.value)
        && (!majorInput.value || row.a === majorInput.value)
        && (!minorInput.value || row.c === minorInput.value));
    }

    // 대분류를 고르면 그 안의 소분류만 남긴다.
    function syncMinors() {
      const pool = majorInput.value ? rows.filter(row => row.a === majorInput.value) : rows;
      const minors = [...new Set(pool.map(row => row.c).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
      const keep = minors.includes(minorInput.value) ? minorInput.value : '';
      minorInput.innerHTML = `<option value="">소분류 전체</option>`
        + minors.map(v => `<option value="${esc(v)}" ${v === keep ? 'selected' : ''}>${esc(v)}</option>`).join('');
    }

    // 몇 건이 어느 날짜에 걸리는지 먼저 보여 준다.
    function syncPreview() {
      const list = targets();
      const days = [...new Set(list.map(row => row.date))].sort();
      const label = managerInput.value || NO_MANAGER;
      saveButton.disabled = list.length === 0;
      const scope = [majorInput.value, minorInput.value].filter(Boolean).join(' › ') || '상품 전체';
      preview.innerHTML = list.length
        ? `<strong>${esc(list.length.toLocaleString('ko-KR'))}건</strong>을 <strong>${esc(label)}</strong>(으)로 배정합니다.
           <span>${esc(days[0].replace(/-/g, '.'))}${days.length > 1 ? ` ~ ${esc(days[days.length - 1].replace(/-/g, '.'))}` : ''} · ${esc(String(days.length))}일치 · ${esc(scope)}</span>`
        : `<span>고른 조건(${esc(scope)})에 맞는 접수가 없습니다.</span>`;
    }

    majorInput.addEventListener('change', () => { syncMinors(); syncPreview(); });
    [fromInput, toInput, minorInput, managerInput].forEach(input => input.addEventListener('change', syncPreview));
    syncMinors();
    syncPreview();

    dialog.querySelector('[data-assign-cancel]').addEventListener('click', closeDetailModal);
    dialog.querySelector('[data-assign-save]').addEventListener('click', () => {
      const list = targets();
      if (!list.length) return;
      const manager = managerInput.value;
      list.forEach(row => { row.manager = manager; });
      saveIntakeDraft();
      closeDetailModal();
      renderPlannedModule('final-settlement');
      const scope = [majorInput.value, minorInput.value].filter(Boolean).join(' › ');
      showToast(`${scope ? `${scope} ` : ''}${list.length.toLocaleString('ko-KR')}건을 ${manager || NO_MANAGER}(으)로 배정했습니다.`);
    });
  }

  // 공급사 정산 — 수량이 맞는지 확인하고 지불액을 확정한다.
  function openVendorDialog(supplier) {
    const group = vendorGroups().find(item => item.supplier === supplier);
    if (!group) return;
    const open = group.rows.filter(row => !row.vendorPaid);
    const openQty = open.reduce((sum, row) => sum + (Number(row.qty) || 0) * signOf(row), 0);

    openDetailModal(`공급사 정산 · ${supplier}`, `
      <div class="paid-summary">
        <article><span>미지불 건수</span><strong>${esc(open.length.toLocaleString('ko-KR'))}건</strong></article>
        <article><span>총 수량</span><strong>${esc(openQty.toLocaleString('ko-KR'))}</strong></article>
        <article><span>지불할 금액</span><strong>${esc(group.openDue.toLocaleString('ko-KR'))}</strong></article>
      </div>

      <div class="sales-table-scroll vendor-detail">
        <table class="sales-table">
          <thead><tr><th scope="col">일자</th><th scope="col">업체명</th><th scope="col">상품</th><th scope="col">수량</th><th scope="col">원가</th><th scope="col">공급가</th></tr></thead>
          <tbody>
            ${group.rows.map(row => {
              const qty = (Number(row.qty) || 0) * signOf(row);
              const hasCost = row.cost !== null && row.cost !== undefined;
              return `<tr class="${row.vendorPaid ? 'vendor-done' : ''}">
                <td>${esc(row.date.slice(5).replace('-', '/'))}</td>
                <th scope="row">${esc(row.client || '업체 미입력')}</th>
                <td>${esc(row.b)} › ${esc(row.c)}</td>
                <td>${esc(qty.toLocaleString('ko-KR'))}</td>
                <td>${hasCost ? esc(Number(row.cost).toLocaleString('ko-KR')) : '상시변동'}</td>
                <td>${hasCost ? esc((Number(row.cost) * qty).toLocaleString('ko-KR')) : '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>

      ${group.variable ? `<p class="paid-hint warn">단가가 상시변동인 ${esc(String(group.variable))}건은 원가가 정해져 있지 않아 위 금액에 빠져 있습니다. 실제 지불액을 직접 확인하세요.</p>` : ''}

      <div class="paid-field">
        <label class="paid-label" for="vendorQty">확인한 수량 <em class="paid-required">필수</em></label>
        <input class="paid-input" id="vendorQty" type="number" placeholder="공급처에서 확인한 수량">
        <small class="paid-hint">공급처와 맞춰 본 수량을 넣으세요. ${esc(openQty.toLocaleString('ko-KR'))}과(와) 다르면 정산되지 않습니다.</small>
      </div>
      <div class="paid-field">
        <label class="paid-label" for="vendorAmount">지불 금액</label>
        <input class="paid-input" id="vendorAmount" type="number" value="${esc(String(group.openDue))}">
      </div>
      <div class="paid-field">
        <label class="paid-label" for="vendorBy">정산자 <em class="paid-required">필수</em></label>
        <input class="paid-input" id="vendorBy" type="text" value="${esc(group.settledBy[0] || userDoc?.name || '')}" placeholder="정산을 처리한 사람">
        <small class="paid-hint">공급처에 실제로 돈을 보낸 사람을 적으세요.</small>
      </div>
      <div class="paid-field">
        <label class="paid-label" for="vendorBank">통장 종류 <em class="paid-required">필수</em></label>
        <select class="paid-input" id="vendorBank">
          ${BANK_ACCOUNTS.map(v => `<option value="${esc(v)}" ${v === (group.banks[0] || BANK_DEFAULT) ? 'selected' : ''}>${esc(v)}</option>`).join('')}
        </select>
        <small class="paid-hint">어느 통장에서 나갔는지 고르세요.</small>
      </div>
      <div class="paid-field">
        <label class="paid-label" for="vendorDate">지불일</label>
        <input class="paid-input" id="vendorDate" type="date" value="${esc(localDateKey(new Date()))}">
      </div>
      <div class="paid-field">
        <label class="paid-label" for="vendorMemo">정산 특이사항 <em class="paid-required">필수</em></label>
        <input class="paid-input" id="vendorMemo" type="text" placeholder="어느 통장에서 어떻게 보냈는지 적어 주세요">
      </div>

      <div class="paid-actions">
        <button class="module-action" type="button" data-vendor-cancel>취소</button>
        <button class="module-action primary" type="button" data-vendor-save ${open.length ? '' : 'disabled'}>${open.length ? '정산 확정' : '정산 완료됨'}</button>
      </div>`, { locked: true });

    const dialog = document.getElementById('readonlyModalBody');
    dialog.querySelector('[data-vendor-cancel]').addEventListener('click', closeDetailModal);
    dialog.querySelector('[data-vendor-save]')?.addEventListener('click', () => {
      const qtyInput = document.getElementById('vendorQty');
      const memoInput = document.getElementById('vendorMemo');
      const checked = Number(qtyInput.value);
      // 수량이 맞아야 지불한다. 이게 공급사 정산의 핵심이다.
      if (!qtyInput.value.trim() || !Number.isFinite(checked)) {
        qtyInput.focus();
        showToast('공급처에서 확인한 수량을 넣어 주세요.');
        return;
      }
      if (checked !== openQty) {
        qtyInput.focus();
        showToast(`수량이 맞지 않습니다. 접수 ${openQty.toLocaleString('ko-KR')} / 확인 ${checked.toLocaleString('ko-KR')}`);
        return;
      }
      if (memoInput.value.trim().length < 8) {
        memoInput.focus();
        showToast('정산 특이사항을 8자 이상 적어 주세요.');
        return;
      }
      const amount = Number(document.getElementById('vendorAmount').value) || 0;
      const date = document.getElementById('vendorDate').value;
      const bank = document.getElementById('vendorBank').value;
      const byInput = document.getElementById('vendorBy');
      const settledBy = byInput.value.trim();
      if (!settledBy) {
        byInput.focus();
        showToast('정산자 이름을 적어 주세요.');
        return;
      }
      const memo = memoInput.value.trim();
      open.forEach(row => {
        row.vendorPaid = true;
        row.vendorPaidDate = date;
        row.vendorBank = bank;
        row.vendorBy = settledBy;
        row.vendorMemo = memo;
      });
      saveIntakeDraft();
      closeDetailModal();
      renderPlannedModule('final-settlement');
      showToast(`${settledBy}님이 ${bank}에서 ${supplier}에 ${amount.toLocaleString('ko-KR')}원을 지불해 ${open.length}건을 정산했습니다.`);
    });
  }

  function renderIntakeLedger() {
    const groups = intakeRowsByDate();
    // 개인정산서는 영업자 단가 기준으로만 본다.
    const showCost = false;
    const shown = filteredIntake();
    const month = intakeTotals(shown);

    if (!groups.length) {
      return `<section class="module-section">
        <div class="module-section-head">
          <span><strong>내 개인정산서</strong><small>접수한 건이 일자별로 쌓입니다</small></span>
          <span class="intake-head-right">
            <button class="module-action" type="button" data-estimate-new>＋ 새 정산서</button>
          </span>
        </div>
        <div class="module-section-body">
          ${renderFinancePeriodFilter('settlement', '접수일 기준')}
          ${personalRows().length ? renderIntakeFilter() : ''}
          <p class="sales-state">${personalRows().length
            ? '조회 조건에 맞는 접수가 없습니다.'
            : '아직 접수한 건이 없습니다. 위에서 상품을 접수해 보세요.'}</p>
        </div>
      </section>`;
    }

    const weekday = ['일', '월', '화', '수', '목', '금', '토'];

    return `<section class="module-section">
      <div class="module-section-head">
        <span><strong>내 개인정산서</strong><small>${esc(userDoc?.name || '')} · ${intakeQueryActive()
          ? `조회 ${shown.length}건 / 전체 ${personalRows().length}건`
          : `접수 ${personalRows().length}건`}</small></span>
        <span class="intake-head-right">
          <span class="module-chip live">매출 ${esc(month.sales.toLocaleString('ko-KR'))}원 · 영업이익 ${esc(month.profit.toLocaleString('ko-KR'))}원</span>
          <button class="module-action" type="button" data-estimate-new>＋ 새 정산서</button>
          <button class="module-action primary" type="button" data-estimate-open>정산서 발행</button>
        </span>
      </div>
      <div class="module-section-body">
        ${renderFinancePeriodFilter('settlement', '접수일 기준')}
        ${renderIntakeFilter()}
        <div class="pick-bar-slot">${pickBarMarkup()}</div>
        ${groups.map(([date, rows]) => {
          const day = intakeTotals(rows);
          const dow = weekday[new Date(`${date}T00:00:00`).getDay()] || '';
          return `<div class="ledger-day">
            <div class="ledger-day-head">
              <strong>${esc(date.slice(5).replace('-', '/'))} (${esc(dow)})</strong>
              <span>매출 ${esc(day.sales.toLocaleString('ko-KR'))} · 영업이익 <em>${esc(day.profit.toLocaleString('ko-KR'))}</em></span>
            </div>
            <div class="sales-table-scroll">
              <table class="sales-table ledger-table">
                <thead>
                  <tr>
                    <th scope="col" aria-label="선택"></th>
                    <th scope="col">업체명</th>
                    <th scope="col">상품</th>
                    <th scope="col">수량</th>
                    <th scope="col">영업자단가</th>
                    <th scope="col">판매단가</th>
                    <th scope="col">특이사항</th>
                    ${showCost ? '<th scope="col">회사원가</th>' : ''}
                    <th scope="col">매출</th>
                    <th scope="col">영업이익</th>
                    <th scope="col">입금</th>
                    <th scope="col" aria-label="삭제"></th>
                  </tr>
                </thead>
                <tbody>
                  ${rows.map(row => {
                    const kind = kindOf(row);
                    const sign = signOf(row);
                    const supply = (Number(row.unit) || 0) * (Number(row.qty) || 0) * sign;
                    const sales = (Number(row.sell) || 0) * (Number(row.qty) || 0) * sign;
                    return `<tr class="${intakeSelection.includes(row.id) ? 'picked' : ''} ${kind !== 'normal' ? `kind-${kind}` : ''}">
                      <td class="ledger-pick"><input type="checkbox" data-intake-pick="${esc(row.id)}" ${intakeSelection.includes(row.id) ? 'checked' : ''} aria-label="${esc(row.client || '')} 선택"></td>
                      <th scope="row">${esc(row.client || '업체 미입력')}${kind === 'normal' ? '' : `<span class="kind-badge ${esc(kind)}">${esc(kindLabel(row))}</span>`}</th>
                      <td class="ledger-product">${esc(row.a)} › ${esc(row.b)} › ${esc(row.c)}</td>
                      <td>${esc((Number(row.qty) * sign).toLocaleString('ko-KR'))}</td>
                      <td>${esc(Number(row.unit).toLocaleString('ko-KR'))}</td>
                      <td>${esc(Number(row.sell).toLocaleString('ko-KR'))}</td>
                      <td class="ledger-memo">${row.memo ? esc(row.memo) : '<span class="ledger-memo-empty">—</span>'}</td>
                      ${showCost ? `<td>${kind === 'reserve' || row.cost === null || row.cost === undefined ? '—' : esc((Number(row.cost) * Number(row.qty) * sign).toLocaleString('ko-KR'))}</td>` : ''}
                      <td>${kind === 'reserve' ? '<span class="ledger-memo-empty">—</span>' : esc(sales.toLocaleString('ko-KR'))}</td>
                      <td class="sales-cell-total">${kind === 'reserve' ? '<span class="ledger-memo-empty">—</span>' : esc((sales - supply).toLocaleString('ko-KR'))}</td>
                      <td>${renderPaidCell(row)}</td>
                      <td><button class="ledger-remove" type="button" data-intake-remove="${esc(row.id)}" aria-label="${esc(row.client || '')} 접수 삭제">✕</button></td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>`;
        }).join('')}

        <div class="ledger-total">
          <span>합계</span>
          <span>매출 <strong>${esc(month.sales.toLocaleString('ko-KR'))}</strong></span>
          ${showCost ? `<span>회사원가 <strong>${esc(month.cost.toLocaleString('ko-KR'))}</strong></span>` : ''}
          <span>영업이익 <strong class="profit">${esc(month.profit.toLocaleString('ko-KR'))}</strong></span>
          <span>입금 <strong>${esc(month.paid.toLocaleString('ko-KR'))}</strong></span>
          <span>미입금 <strong class="unpaid">${esc(Math.max(0, month.sales - month.paid).toLocaleString('ko-KR'))}</strong></span>
          ${month.reserve ? `<span>예약금 잔여 <strong class="reserve">${esc(month.reserve.toLocaleString('ko-KR'))}</strong></span>` : ''}
        </div>
      </div>
    </section>`;
  }

  // 최종정산서는 실제로 일이 들어간 건만 올린다.
  // 당일접수 / 예약건 작업 / 환불 / 예약건환불 네 가지이며, 선입금만 받아 둔
  // 예약최초건은 매출이 아니므로 올라가지 않는다.
  // 거래처에 보내는 작업 견적서. 우리 회사 정보는 고정이고 나머지는 그때그때 고친다.
  const ESTIMATE_ISSUER = {
    company: '주식회사 피크마케팅',
    ceo: '김진봉',
    bizNo: '812-86-03331'
  };

  // 받는 통장이 상품에 따라 다르다. 정산서마다 골라서 찍는다.
  const ESTIMATE_BANKS = [
    ['피크마케팅', '기업은행 568-048256-04-017'],
    ['리워드스페이스', '기업은행 076-507041-04-022'],
    ['리뷰스페이스', '기업은행 076-507041-04-015']
  ];
  const ESTIMATE_MIN_ROWS = 8;
  const ESTIMATE_NOTE = '*입금자명이 업체명과 다를 시 세금계산서발행이 누락될 수 있습니다. 업체명으로 입금확인 부탁드립니다 :)';

  let estimateDraft = null;

  function estimateRowsFor(client) {
    return personalRows()
      .filter(row => (row.client || '') === client && inFinancePeriod(row.date))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  // 화면에서 고친 값만 들고 있는다. 접수 원본은 건드리지 않는다.
  function estimateLineOf(row) {
    return {
      category: row.a || '',
      name: row.c || '',
      unit: (Number(row.sell) || 0) * (kindOf(row) === 'refund' ? -1 : 1),
      qty: Number(row.qty) || 0
    };
  }

  // rows 를 넘기면 그것만, 안 넘기면 그 업체 접수 전부를 담는다.
  // client 가 비어 있으면 빈 정산서로 새로 시작한다.
  function buildEstimateDraft(client, rows) {
    const source = rows || (client ? estimateRowsFor(client) : []);
    return {
      client: client || '',
      clientCeo: '',
      manager: String(userDoc?.name || '').trim(),
      date: localDateKey(new Date()),
      bank: ESTIMATE_BANKS[0][0],
      lines: source.length ? source.map(estimateLineOf) : [{ category: '', name: '', unit: 0, qty: 0 }]
    };
  }

  function estimateBankNumber(draft) {
    const found = ESTIMATE_BANKS.find(([name]) => name === draft.bank);
    return (found || ESTIMATE_BANKS[0])[1];
  }

  function estimateTotals(draft) {
    const supply = draft.lines.reduce((sum, line) => sum + Math.round((Number(line.unit) || 0) * (Number(line.qty) || 0)), 0);
    const tax = Math.round(supply * 0.1);
    return { supply, tax, total: supply + tax };
  }

  function estimateFileName(draft) {
    const safe = String(draft.client || '거래처').replace(/[\\/:*?"<>|]/g, '');
    return `견적서_${safe}_${draft.date.replace(/-/g, '')}.png`;
  }

  // 캔버스에 직접 그린다. 외부 라이브러리 없이 저장까지 되어야 해서 이렇게 한다.
  function drawEstimate(canvas, draft) {
    const W = 1160;
    const rowH = 30;
    const lineCount = Math.max(ESTIMATE_MIN_ROWS, draft.lines.length);
    const H = 96 + 4 * 32 + 16 + 32 + lineCount * rowH + 2 * 32 + 64;
    const scale = 2;
    canvas.width = W * scale;
    canvas.height = H * scale;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';

    const g = canvas.getContext('2d');
    g.scale(scale, scale);
    const font = (size, weight = '400') => `${weight} ${size}px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
    const won = value => Number(value || 0).toLocaleString('ko-KR');

    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, H);

    const cell = (x, y, w, h, fill) => {
      if (fill) { g.fillStyle = fill; g.fillRect(x, y, w, h); }
      g.strokeStyle = '#b7bcc4';
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    };
    const text = (value, x, y, { align = 'center', size = 13, weight = '400', color = '#111827' } = {}) => {
      g.fillStyle = color;
      g.font = font(size, weight);
      g.textAlign = align;
      g.textBaseline = 'middle';
      g.fillText(String(value ?? ''), x, y);
    };

    // 제목과 로고
    text('WORK ESTIMATE', W / 2, 34, { size: 20, weight: '700' });
    g.fillStyle = '#e8734a';
    g.fillRect(W - 232, 22, 26, 26);
    g.fillStyle = '#ffffff';
    g.fillRect(W - 228, 27, 18, 4);
    g.fillRect(W - 228, 34, 18, 4);
    g.fillRect(W - 228, 41, 18, 4);
    text('PEAK MARKETING', W - 12, 36, { align: 'right', size: 17, weight: '700', color: '#3f3f46' });

    // 파란 띠
    g.fillStyle = '#2b35d8';
    g.fillRect(0, 62, W, 10);

    // 발행자 / 거래처 정보
    const infoTop = 82;
    const cols = [0, 135, 610, 765, W];
    const info = [
      ['회사명', ESTIMATE_ISSUER.company, '거래처명', draft.client || ''],
      ['대표자', ESTIMATE_ISSUER.ceo, '대표자', draft.clientCeo || ''],
      ['사업자등록번호', ESTIMATE_ISSUER.bizNo, '발행일자', draft.date.replace(/-0?/g, '. ').replace(/^\. /, '')],
      ['담당자', draft.manager || '', '입금 계좌번호', estimateBankNumber(draft)]
    ];
    info.forEach((row, i) => {
      const y = infoTop + i * 32;
      [0, 2].forEach(k => {
        const cx = cols[k];
        cell(cx, y, cols[k + 1] - cx, 32, '#ededed');
        text(row[k], cx + (cols[k + 1] - cx) / 2, y + 16, { size: 13, weight: '700', color: '#1f2937' });
        cell(cols[k + 1], y, cols[k + 2] - cols[k + 1], 32, '#ffffff');
        text(row[k + 1], cols[k + 1] + (cols[k + 2] - cols[k + 1]) / 2, y + 16, { size: 13, weight: '700' });
      });
    });

    // 품목 표
    const tableTop = infoTop + 4 * 32 + 16;
    const c = [0, 160, 620, 755, 890, 1025, W];
    const heads = ['카테고리', '상품명', '단가', '수량', '공급가액', '세액'];
    heads.forEach((label, i) => {
      cell(c[i], tableTop, c[i + 1] - c[i], 32, '#ededed');
      text(label, c[i] + (c[i + 1] - c[i]) / 2, tableTop + 16, { size: 13, weight: '700', color: '#1f2937' });
    });

    const bodyTop = tableTop + 32;
    // 카테고리는 세로로 병합한 것처럼 한 칸으로 둔다
    cell(c[0], bodyTop, c[1] - c[0], lineCount * rowH, '#f3f3f3');
    const categories = [...new Set(draft.lines.map(line => line.category).filter(Boolean))];
    text(categories.join(' · ') || '', c[0] + (c[1] - c[0]) / 2, bodyTop + (lineCount * rowH) / 2, { size: 13, weight: '700', color: '#1f2937' });

    for (let i = 0; i < lineCount; i += 1) {
      const y = bodyTop + i * rowH;
      const line = draft.lines[i];
      for (let k = 1; k < 6; k += 1) cell(c[k], y, c[k + 1] - c[k], rowH, '#ffffff');
      if (!line) continue;
      const supply = Math.round((Number(line.unit) || 0) * (Number(line.qty) || 0));
      text(line.name, c[1] + (c[2] - c[1]) / 2, y + rowH / 2, { size: 12.5, weight: '700' });
      text(won(line.unit), c[2] + (c[3] - c[2]) / 2, y + rowH / 2, { size: 12.5, weight: '700' });
      text(won(line.qty), c[3] + (c[4] - c[3]) / 2, y + rowH / 2, { size: 12.5, weight: '700' });
      text(won(supply), c[4] + (c[5] - c[4]) / 2, y + rowH / 2, { size: 12.5, weight: '700' });
      text(won(Math.round(supply * 0.1)), c[5] + (c[6] - c[5]) / 2, y + rowH / 2, { size: 12.5, weight: '700' });
    }

    // 합계
    const sums = estimateTotals(draft);
    const sumTop = bodyTop + lineCount * rowH;
    [['소계', won(sums.supply), won(sums.tax)], ['합계(VAT 포함)', '', `${won(sums.total)}원`]].forEach((row, i) => {
      const y = sumTop + i * 32;
      cell(c[2], y, c[3] - c[2], 32, '#ededed');
      text(row[0], c[2] + (c[3] - c[2]) / 2, y + 16, { size: 13, weight: '700', color: '#1f2937' });
      cell(c[3], y, c[4] - c[3], 32, '#ffffff');
      cell(c[4], y, c[5] - c[4], 32, '#ffffff');
      text(row[1], c[4] + (c[5] - c[4]) / 2, y + 16, { size: 12.5, weight: '700' });
      cell(c[5], y, c[6] - c[5], 32, '#ffffff');
      text(row[2], c[5] + (c[6] - c[5]) / 2, y + 16, { size: 12.5, weight: '700' });
    });

    text(ESTIMATE_NOTE, W - 8, sumTop + 2 * 32 + 34, { align: 'right', size: 12.5, weight: '700', color: '#d93025' });
  }

  function renderEstimateLines() {
    const draft = estimateDraft;
    return draft.lines.map((line, index) => `<tr>
      <td><input class="paid-input est-input" data-est-line="category" data-est-index="${index}" type="text" value="${esc(line.category)}" aria-label="카테고리"></td>
      <td><input class="paid-input est-input wide" data-est-line="name" data-est-index="${index}" type="text" value="${esc(line.name)}" aria-label="상품명"></td>
      <td><input class="paid-input est-input num" data-est-line="unit" data-est-index="${index}" type="number" value="${esc(String(line.unit))}" aria-label="단가"></td>
      <td><input class="paid-input est-input num" data-est-line="qty" data-est-index="${index}" type="number" value="${esc(String(line.qty))}" aria-label="수량"></td>
      <td class="est-supply">${esc(Math.round((Number(line.unit) || 0) * (Number(line.qty) || 0)).toLocaleString('ko-KR'))}</td>
      <td><button class="module-action" type="button" data-est-remove="${index}" aria-label="줄 삭제">✕</button></td>
    </tr>`).join('');
  }

  // 거래처 하나에 대해 접수 건을 모아 견적서 한 장으로 만든다.
  function openEstimateDialog(client, rows) {
    estimateDraft = buildEstimateDraft(client, rows);
    const clients = [...new Set(personalRows()
      .filter(row => inFinancePeriod(row.date))
      .map(row => row.client)
      .filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));

    openDetailModal('정산서 발행 · WORK ESTIMATE', `
      <div class="est-head">
        <label class="paid-field"><span class="paid-label">거래처</span>
          <input class="paid-input" id="estClient" type="text" list="estClientList" value="${esc(estimateDraft.client)}" placeholder="업체명 직접 입력">
          <datalist id="estClientList">${clients.map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist></label>
        <label class="paid-field"><span class="paid-label">거래처 대표자</span>
          <input class="paid-input" id="estCeo" type="text" placeholder="대표자명"></label>
        <label class="paid-field"><span class="paid-label">담당자</span>
          <input class="paid-input" id="estManager" type="text" value="${esc(estimateDraft.manager)}"></label>
        <label class="paid-field"><span class="paid-label">발행일자</span>
          <input class="paid-input" id="estDate" type="date" value="${esc(estimateDraft.date)}"></label>
        <label class="paid-field"><span class="paid-label">입금 통장</span>
          <select class="paid-input" id="estBank">
            ${ESTIMATE_BANKS.map(([name, number]) => `<option value="${esc(name)}" ${name === estimateDraft.bank ? 'selected' : ''}>${esc(name)} · ${esc(number)}</option>`).join('')}
          </select></label>
      </div>

      <p class="paid-hint">${esc(financePeriodLabel())} 접수만 불러옵니다. 카테고리와 상품명은 거래처에 보낼 이름으로 고쳐 쓰세요. 접수 원본은 바뀌지 않습니다.</p>

      <div class="sales-table-scroll est-lines">
        <table class="sales-table">
          <thead><tr><th scope="col">카테고리</th><th scope="col">상품명</th><th scope="col">단가</th><th scope="col">수량</th><th scope="col">공급가액</th><th scope="col" aria-label="삭제"></th></tr></thead>
          <tbody id="estLines">${renderEstimateLines()}</tbody>
        </table>
      </div>
      <div class="est-tools">
        <span class="est-tool-buttons">
          <button class="module-action" type="button" data-est-add>＋ 줄 추가</button>
          <button class="module-action" type="button" data-est-load>조회 기간 접수 불러오기</button>
          <button class="module-action" type="button" data-est-clear>비우기</button>
        </span>
        <span class="est-sum" id="estSum"></span>
      </div>

      <div class="est-preview"><canvas id="estCanvas"></canvas></div>

      <div class="paid-actions">
        <button class="module-action" type="button" data-est-close>닫기</button>
        <button class="module-action primary" type="button" data-est-download>이미지 저장</button>
      </div>`, { locked: true });

    const dialog = document.getElementById('readonlyModalBody');
    const canvas = document.getElementById('estCanvas');
    const linesBody = document.getElementById('estLines');

    function refreshPreview() {
      const sums = estimateTotals(estimateDraft);
      document.getElementById('estSum').textContent =
        `공급가액 ${sums.supply.toLocaleString('ko-KR')} · 세액 ${sums.tax.toLocaleString('ko-KR')} · 합계 ${sums.total.toLocaleString('ko-KR')}원`;
      drawEstimate(canvas, estimateDraft);
    }

    function redrawLines() {
      linesBody.innerHTML = renderEstimateLines();
      wireLines();
      refreshPreview();
    }

    function wireLines() {
      linesBody.querySelectorAll('[data-est-line]').forEach(input => {
        // 글자를 칠 때마다 줄을 다시 그리면 커서가 튀므로 미리보기만 갱신한다
        input.addEventListener('input', () => {
          const line = estimateDraft.lines[Number(input.dataset.estIndex)];
          if (!line) return;
          const key = input.dataset.estLine;
          line[key] = (key === 'unit' || key === 'qty') ? Number(input.value) || 0 : input.value;
          const cellEl = input.closest('tr').querySelector('.est-supply');
          if (cellEl) cellEl.textContent = Math.round((Number(line.unit) || 0) * (Number(line.qty) || 0)).toLocaleString('ko-KR');
          refreshPreview();
        });
      });
      linesBody.querySelectorAll('[data-est-remove]').forEach(button => button.addEventListener('click', () => {
        estimateDraft.lines.splice(Number(button.dataset.estRemove), 1);
        redrawLines();
      }));
    }

    ['estCeo', 'estManager', 'estDate', 'estBank'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => {
        estimateDraft.clientCeo = document.getElementById('estCeo').value;
        estimateDraft.manager = document.getElementById('estManager').value;
        estimateDraft.date = document.getElementById('estDate').value || estimateDraft.date;
        estimateDraft.bank = document.getElementById('estBank').value;
        refreshPreview();
      });
    });
    document.getElementById('estClient').addEventListener('input', event => {
      estimateDraft.client = event.target.value;
      refreshPreview();
    });
    dialog.querySelector('[data-est-load]').addEventListener('click', () => {
      const name = document.getElementById('estClient').value.trim();
      const found = estimateRowsFor(name);
      if (!found.length) {
        showToast(`${name || '업체'} 이름으로 접수된 건이 없습니다.`);
        return;
      }
      estimateDraft.lines = found.map(estimateLineOf);
      redrawLines();
      showToast(`${name} ${financePeriodLabel()} 접수 ${found.length}건을 불러왔습니다.`);
    });
    dialog.querySelector('[data-est-clear]').addEventListener('click', () => {
      estimateDraft.lines = [];
      redrawLines();
    });
    dialog.querySelector('[data-est-add]').addEventListener('click', () => {
      estimateDraft.lines.push({ category: '', name: '', unit: 0, qty: 0 });
      redrawLines();
    });
    dialog.querySelector('[data-est-close]').addEventListener('click', closeDetailModal);
    dialog.querySelector('[data-est-download]').addEventListener('click', () => {
      canvas.toBlob(blob => {
        if (!blob) {
          showToast('이미지를 만들지 못했습니다.');
          return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = estimateFileName(estimateDraft);
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast(`${estimateDraft.client} 정산서를 저장했습니다.`);
      }, 'image/png');
    });

    wireLines();
    refreshPreview();
  }

  // 단가표 — 최종정산서에서는 회사원가까지, 개인정산서에서는 영업자단가만.
  let priceTableQuery = '';

  let editingPriceKey = '';

  function renderPriceTableBody() {
    const showCost = showCompanyCost();
    const canEdit = showCost;
    const q = priceTableQuery.trim().toLowerCase().replace(/\s/g, '');
    const rows = priceRows().filter(row => !q || `${row[0]}${row[1]}${row[2]}`.toLowerCase().replace(/\s/g, '').includes(q));
    const won = value => value === null ? '상시변동' : Number(value).toLocaleString('ko-KR');
    const cols = 3 + (showCost ? 1 : 0) + 1 + (canEdit ? 1 : 0);

    return `<div class="sales-table-scroll price-table-scroll">
      <table class="sales-table price-table">
        <thead>
          <tr>
            <th scope="col">대분류</th>
            <th scope="col">중분류</th>
            <th scope="col">소분류</th>
            ${showCost ? '<th scope="col">회사원가</th>' : ''}
            <th scope="col">영업자단가</th>
            ${canEdit ? '<th scope="col" aria-label="수정"></th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map(row => {
            const key = priceKey(row);
            const editing = canEdit && editingPriceKey === key;
            const badges = `${isCustomPrice(row) ? '<span class="kind-badge added">추가</span>' : ''}${row.edited ? '<span class="kind-badge edited">수정</span>' : ''}`;
            if (editing) {
              return `<tr class="price-editing">
                <td>${esc(row[0])}</td>
                <td>${esc(row[1])}</td>
                <th scope="row">${esc(row[2])}${badges}</th>
                <td><input class="paid-input price-edit-input" type="number" min="0" data-price-edit="cost" value="${esc(row[3] === null ? '' : String(row[3]))}" placeholder="상시변동"></td>
                <td><input class="paid-input price-edit-input" type="number" min="0" data-price-edit="unit" value="${esc(row[4] === null ? '' : String(row[4]))}" placeholder="상시변동"></td>
                <td class="price-actions">
                  <button class="module-action primary" type="button" data-price-edit-save="${esc(key)}">저장</button>
                  <button class="module-action" type="button" data-price-edit-cancel>취소</button>
                </td>
              </tr>`;
            }
            return `<tr class="${isCustomPrice(row) ? 'price-added' : ''}">
              <td>${esc(row[0])}</td>
              <td>${esc(row[1])}</td>
              <th scope="row">${esc(row[2])}${badges}</th>
              ${showCost ? `<td class="${row[3] === null ? 'ledger-memo-empty' : ''}">${esc(won(row[3]))}</td>` : ''}
              <td class="${row[4] === null ? 'ledger-memo-empty' : ''}">${esc(won(row[4]))}</td>
              ${canEdit ? `<td class="price-actions"><button class="module-action" type="button" data-price-edit-open="${esc(key)}">수정</button>${row.edited ? `<button class="module-action" type="button" data-price-edit-reset="${esc(key)}">되돌리기</button>` : ''}</td>` : ''}
            </tr>`;
          }).join('')
          : `<tr><td colspan="${cols}" class="ledger-memo-empty">찾는 상품이 없습니다.</td></tr>`}
        </tbody>
      </table>
    </div>
    <p class="paid-hint">${esc(rows.length.toLocaleString('ko-KR'))}건 / 전체 ${esc(priceRows().length.toLocaleString('ko-KR'))}건${showCost ? '' : ' · 회사원가는 최종정산서에서만 볼 수 있습니다'}</p>`;
  }

  function openPriceTable() {
    priceTableQuery = '';
    editingPriceKey = '';
    const showCost = showCompanyCost();

    openDetailModal(showCost ? '단가표 · 회사원가 / 영업자단가' : '단가표 · 영업자단가', `
      <div class="price-warning">
        <span class="price-warning-icon" aria-hidden="true">!</span>
        <span><strong>주의 · 대외비</strong><br>피크마케팅 회사 내 타인에게 공유는 절대로 금합니다.</span>
      </div>

      <div class="price-tools">
        <label class="paid-field price-search">
          <span class="paid-label">상품 찾기</span>
          <input class="paid-input" id="priceSearch" type="search" placeholder="대분류 · 중분류 · 소분류로 검색" autocomplete="off">
        </label>
        ${showCost ? '<button class="module-action primary" type="button" data-price-add>＋ 상품 추가</button>' : ''}
      </div>

      ${showCost ? `<div class="price-form" id="priceForm" hidden>
        <div class="price-form-grid">
          <label class="paid-field"><span class="paid-label">대분류</span>
            <input class="paid-input" id="newMajor" type="text" list="priceMajors" placeholder="예: 블로그"></label>
          <label class="paid-field"><span class="paid-label">중분류</span>
            <input class="paid-input" id="newMiddle" type="text" placeholder="예: 원고"></label>
          <label class="paid-field"><span class="paid-label">소분류</span>
            <input class="paid-input" id="newMinor" type="text" placeholder="예: 프리미엄원고대필"></label>
          <label class="paid-field"><span class="paid-label">회사원가</span>
            <input class="paid-input" id="newCost" type="number" min="0" placeholder="비우면 상시변동"></label>
          <label class="paid-field"><span class="paid-label">영업자단가</span>
            <input class="paid-input" id="newUnit" type="number" min="0" placeholder="비우면 상시변동"></label>
        </div>
        <datalist id="priceMajors">${[...new Set(priceRows().map(row => row[0]))].map(v => `<option value="${esc(v)}"></option>`).join('')}</datalist>
        <p class="paid-hint">단가를 비우면 상시변동으로 잡혀 접수할 때 직접 넣습니다. 추가한 상품은 영업자들 단가표에도 <strong>영업자단가만</strong> 함께 보입니다.</p>
        <div class="paid-actions">
          <button class="module-action" type="button" data-price-add-cancel>취소</button>
          <button class="module-action primary" type="button" data-price-add-save>상품 추가</button>
        </div>
      </div>` : ''}

      <div id="priceTableBody">${renderPriceTableBody()}</div>

      <div class="paid-actions">
        <button class="module-action" type="button" data-price-close>닫기</button>
      </div>`, { locked: true });

    const dialog = document.getElementById('readonlyModalBody');
    const search = document.getElementById('priceSearch');
    const body = document.getElementById('priceTableBody');

    // 표만 다시 그리고 그때마다 버튼을 다시 묶는다.
    function refreshPriceTable() {
      body.innerHTML = renderPriceTableBody();
      wirePriceRows();
    }

    function wirePriceRows() {
      body.querySelectorAll('[data-price-edit-open]').forEach(button => button.addEventListener('click', () => {
        editingPriceKey = button.dataset.priceEditOpen;
        refreshPriceTable();
        body.querySelector('[data-price-edit="cost"], [data-price-edit="unit"]')?.focus();
      }));
      body.querySelector('[data-price-edit-cancel]')?.addEventListener('click', () => {
        editingPriceKey = '';
        refreshPriceTable();
      });
      body.querySelectorAll('[data-price-edit-reset]').forEach(button => button.addEventListener('click', () => {
        const resetKey = button.dataset.priceEditReset;
        delete priceOverrides[resetKey];
        removePriceEntry(resetKey);
        refreshPriceTable();
        renderPlannedModule(intakeContext);
        showToast('단가를 원래대로 되돌렸습니다.');
      }));
      body.querySelector('[data-price-edit-save]')?.addEventListener('click', event => {
        const key = event.currentTarget.dataset.priceEditSave;
        const read = which => {
          const value = body.querySelector(`[data-price-edit="${which}"]`).value.trim();
          return value === '' ? null : Number(value);
        };
        const cost = read('cost');
        const unit = read('unit');
        if ((cost !== null && (!Number.isFinite(cost) || cost < 0)) || (unit !== null && (!Number.isFinite(unit) || unit < 0))) {
          showToast('단가는 0 이상 숫자로 넣어 주세요.');
          return;
        }
        priceOverrides[key] = [cost, unit];
        const parts = key.split('|');
        const target = priceRows().find(row => priceKey(row) === key);
        if (target) { target[3] = cost; target[4] = unit; }
        savePriceEntry(key, parts[0], parts[1], parts[2], cost, unit, Boolean(target && target.custom));
        editingPriceKey = '';
        refreshPriceTable();
        renderPlannedModule(intakeContext);
        showToast(`${key.split('|').join(' › ')} 단가를 바꿨습니다.`);
      });
    }

    search.addEventListener('input', () => {
      priceTableQuery = search.value;
      editingPriceKey = '';
      refreshPriceTable();
    });
    wirePriceRows();
    dialog.querySelector('[data-price-close]').addEventListener('click', closeDetailModal);

    const form = document.getElementById('priceForm');
    dialog.querySelector('[data-price-add]')?.addEventListener('click', () => {
      form.hidden = !form.hidden;
      if (!form.hidden) document.getElementById('newMajor').focus();
    });
    dialog.querySelector('[data-price-add-cancel]')?.addEventListener('click', () => { form.hidden = true; });
    dialog.querySelector('[data-price-add-save]')?.addEventListener('click', () => {
      const value = id => document.getElementById(id).value.trim();
      const a = value('newMajor');
      const b = value('newMiddle');
      const c = value('newMinor');
      if (!a || !b || !c) {
        showToast('대분류·중분류·소분류를 모두 채워 주세요.');
        return;
      }
      if (priceRow(a, b, c)) {
        showToast('이미 단가표에 있는 상품입니다.');
        return;
      }
      const num = id => value(id) === '' ? null : Number(value(id));
      // 단가표와 같은 모양으로 넣어야 접수 화면이 그대로 읽는다.
      customPrices.push([a, b, c, num('newCost'), num('newUnit')]);
      savePriceEntry(`${a}|${b}|${c}`, a, b, c, num('newCost'), num('newUnit'), true);
      form.hidden = true;
      ['newMajor', 'newMiddle', 'newMinor', 'newCost', 'newUnit'].forEach(id => { document.getElementById(id).value = ''; });
      refreshPriceTable();
      renderPlannedModule(intakeContext);
      showToast(`${a} › ${b} › ${c} 상품을 단가표에 추가했습니다.`);
    });
  }

  // 원가가 비어 있으면 회사이익도 공급사 지불액도 계산되지 않는다.
  function missingCostRows() {
    return finalSettlementRows().filter(row => row.cost === null || row.cost === undefined);
  }

  function openCostDialog() {
    const rows = missingCostRows();
    if (!rows.length) return;

    openDetailModal('회사 원가 입력', `
      <p class="paid-hint warn">원가가 상시변동인 상품이라 단가표에 값이 없습니다. 넣어야 회사 영업이익과 공급사 지불액이 잡힙니다.</p>

      <div class="sales-table-scroll vendor-detail">
        <table class="sales-table">
          <thead><tr><th scope="col">일자</th><th scope="col">업체명</th><th scope="col">상품</th><th scope="col">수량</th><th scope="col">회사 원가</th></tr></thead>
          <tbody>
            ${rows.map(row => `<tr>
              <td>${esc(row.date.slice(5).replace('-', '/'))}</td>
              <th scope="row">${esc(row.client || '업체 미입력')}</th>
              <td>${esc(row.b)} › ${esc(row.c)}</td>
              <td>${esc(((Number(row.qty) || 0) * signOf(row)).toLocaleString('ko-KR'))}</td>
              <td><input class="paid-input cost-input" type="number" min="0" data-cost-for="${esc(row.id)}" placeholder="원가" aria-label="${esc(row.client || '')} 회사 원가"></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <p class="paid-hint">비워 둔 건은 그대로 둡니다. 나중에 다시 넣을 수 있습니다.</p>

      <div class="paid-actions">
        <button class="module-action" type="button" data-cost-cancel>취소</button>
        <button class="module-action primary" type="button" data-cost-save>원가 저장</button>
      </div>`, { locked: true });

    const dialog = document.getElementById('readonlyModalBody');
    dialog.querySelector('[data-cost-cancel]').addEventListener('click', closeDetailModal);
    dialog.querySelector('[data-cost-save]').addEventListener('click', () => {
      let filled = 0;
      dialog.querySelectorAll('[data-cost-for]').forEach(input => {
        const value = input.value.trim();
        if (!value) return;
        const row = intakeDraft.find(item => item.id === input.dataset.costFor);
        if (!row) return;
        row.cost = Number(value);
        filled += 1;
      });
      if (!filled) {
        showToast('넣을 원가를 하나 이상 적어 주세요.');
        return;
      }
      saveIntakeDraft();
      closeDetailModal();
      renderPlannedModule('final-settlement');
      showToast(`${filled}건의 회사 원가를 넣었습니다.`);
    });
  }

  // 최종정산서는 이익을 두 가지로 본다.
  //  영업자 영업이익 = 판매가액 - 영업자 공급가액  (영업자가 남긴 몫)
  //  회사   영업이익 = 판매가액 - 회사 공급가       (회사가 실제로 남긴 몫)
  // 원가가 상시변동인 상품은 회사 공급가를 모르므로 회사 이익에서 뺀다.
  function finalTotals(rows) {
    return rows.reduce((sum, row) => {
      const sign = signOf(row);
      const qty = (Number(row.qty) || 0) * sign;
      const sales = (Number(row.sell) || 0) * qty;
      const supply = (Number(row.unit) || 0) * qty;
      const hasCost = row.cost !== null && row.cost !== undefined;
      const vendorDue = hasCost ? Number(row.cost) * qty : 0;

      sum.sales += sales;
      sum.supply += supply;
      sum.salesProfit += sales - supply;
      sum.vendorDue += vendorDue;
      if (hasCost) sum.companyProfit += sales - vendorDue;
      else sum.variable += 1;
      if (!row.vendorPaid) sum.vendorUnpaid += vendorDue;
      return sum;
    }, { sales: 0, supply: 0, salesProfit: 0, vendorDue: 0, companyProfit: 0, vendorUnpaid: 0, variable: 0 });
  }

  // 공급사별 정산 집계. 수량과 지불액이 맞아야 정산 처리를 할 수 있다.
  function vendorGroups() {
    const map = new Map();
    finalSettlementRows().forEach(row => {
      const key = supplierOf(row);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    });
    return [...map.entries()].map(([supplier, rows]) => {
      const sign = row => signOf(row);
      const qty = rows.reduce((sum, row) => sum + (Number(row.qty) || 0) * sign(row), 0);
      // 회사 공급가(진봉) = 회사 원가 x 수량. 이게 공급처에 낼 돈이다.
      const known = rows.filter(row => row.cost !== null && row.cost !== undefined);
      const due = known.reduce((sum, row) => sum + Number(row.cost) * (Number(row.qty) || 0) * sign(row), 0);
      const settled = rows.filter(row => row.vendorPaid);
      const settledDue = settled.reduce((sum, row) => row.cost === null || row.cost === undefined
        ? sum : sum + Number(row.cost) * (Number(row.qty) || 0) * sign(row), 0);
      return {
        supplier, rows, qty, due,
        banks: [...new Set(settled.map(row => row.vendorBank).filter(Boolean))],
        settledBy: [...new Set(settled.map(row => row.vendorBy).filter(Boolean))],
        variable: rows.length - known.length,
        settledCount: settled.length,
        settledDue,
        open: rows.length - settled.length,
        openDue: due - settledDue
      };
    }).sort((a, b) => b.due - a.due);
  }

  // 시트의 '최종 정산' 탭과 같은 열 구성으로 하루치를 그린다.
  function finalDayTable(rows) {
    const showCost = showCompanyCost();
    return `<div class="sales-table-scroll">
      <table class="sales-table final-day-table">
        <thead>
          <tr>
            <th scope="col">접수담당자</th>
            <th scope="col">접수자</th>
            <th scope="col">업체명</th>
            <th scope="col">상품명</th>
            <th scope="col">분류</th>
            <th scope="col">공급처명</th>
            ${showCost ? '<th scope="col">회사 원가</th><th scope="col">회사 공급가</th>' : ''}
            <th scope="col">영업자 단가</th>
            <th scope="col">총 수량</th>
            <th scope="col">영업자 공급가액</th>
            <th scope="col">판매 단가</th>
            <th scope="col">판매가액</th>
            <th scope="col">영업이익(영업자)</th>
            ${showCost ? '<th scope="col">영업이익(회사)</th>' : ''}
            <th scope="col">공급처 입금</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => {
            const sign = signOf(row);
            const qty = (Number(row.qty) || 0) * sign;
            const supply = (Number(row.unit) || 0) * qty;
            const sales = (Number(row.sell) || 0) * qty;
            const hasCost = row.cost !== null && row.cost !== undefined;
            const vendorDue = hasCost ? Number(row.cost) * qty : null;
            const kind = kindOf(row);
            return `<tr class="${kind !== 'normal' ? `kind-${kind}` : ''}">
              <td class="${row.manager ? '' : 'ledger-memo-empty'}">${esc(managerOf(row))}</td>
              <td>${esc(row.ownerName || userDoc?.name || '')}${row.finalOnly ? '<span class="kind-badge final-only">최종전용</span>' : ''}${kind === 'normal' ? '' : `<span class="kind-badge ${esc(kind)}">${esc(kindLabel(row))}</span>`}</td>
              <th scope="row">${esc(row.client || '업체 미입력')}</th>
              <td>${esc(row.b)}</td>
              <td>${esc(row.c)}</td>
              <td>${esc(supplierOf(row))}</td>
              ${showCost ? `<td>${hasCost ? esc(Number(row.cost).toLocaleString('ko-KR')) : '상시변동'}</td>
              <td>${vendorDue === null ? '—' : esc(vendorDue.toLocaleString('ko-KR'))}</td>` : ''}
              <td>${esc(Number(row.unit).toLocaleString('ko-KR'))}</td>
              <td>${esc(qty.toLocaleString('ko-KR'))}</td>
              <td>${esc(supply.toLocaleString('ko-KR'))}</td>
              <td>${esc(Number(row.sell).toLocaleString('ko-KR'))}</td>
              <td>${esc(sales.toLocaleString('ko-KR'))}</td>
              <td class="sales-cell-total">${esc((sales - supply).toLocaleString('ko-KR'))}</td>
              ${showCost ? `<td class="sales-cell-total">${vendorDue === null ? '<span class="ledger-memo-empty">—</span>' : esc((sales - vendorDue).toLocaleString('ko-KR'))}</td>` : ''}
              <td>${row.vendorPaid
                ? `<span class="vendor-chip done" title="${esc(row.vendorBank || '')}">${esc(row.vendorPaidDate || '지불')}${row.vendorBank ? ` · ${esc(row.vendorBank)}` : ''}</span>`
                : '<span class="vendor-chip">미지불</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  }

  function finalFilterActive() {
    return Boolean(finalFilter.from || finalFilter.to || finalFilter.manager);
  }

  function renderFinalSettlement() {
    if (!canSeeFinalSettlement()) return '';
    const all = finalSettlementRows();
    const rows = all.filter(row => {
      if (finalFilter.from && String(row.date) < finalFilter.from) return false;
      if (finalFilter.to && String(row.date) > finalFilter.to) return false;
      // '담당 없음'만 따로 보고 싶을 때가 있어 none 값을 따로 둔다
      if (finalFilter.manager === 'none' && row.manager) return false;
      if (finalFilter.manager && finalFilter.manager !== 'none' && row.manager !== finalFilter.manager) return false;
      return true;
    });
    const managers = [...new Set(all.map(row => row.manager).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
    const total = intakeTotals(rows);
    const final = finalTotals(rows);
    const showCost = showCompanyCost();
    const missing = missingCostRows();
    const held = intakeDraft.filter(row => kindOf(row) === 'reserve');
    const heldAmount = held.reduce((sum, row) => sum + reserveRemaining(row).amount, 0);

    const byDate = new Map();
    rows.forEach(row => {
      if (!byDate.has(row.date)) byDate.set(row.date, []);
      byDate.get(row.date).push(row);
    });
    const days = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    const weekday = ['일', '월', '화', '수', '목', '금', '토'];

    const buckets = [
      ['당일접수', row => kindOf(row) === 'normal'],
      ['예약건 작업', row => kindOf(row) === 'use'],
      ['환불', row => kindOf(row) === 'refund' && !isReserveRefund(row)],
      ['예약건환불', row => kindOf(row) === 'refund' && isReserveRefund(row)]
    ];

    const vendors = vendorGroups();
    const vendorDue = vendors.reduce((sum, group) => sum + group.openDue, 0);

    return `<section class="module-section final-settlement">
      <div class="module-section-head">
        <span><strong>일별 취합</strong><small>${finalFilterActive()
          ? `조회 ${esc(rows.length.toLocaleString('ko-KR'))}건 / 전체 ${esc(all.length.toLocaleString('ko-KR'))}건`
          : '당일접수 · 예약건 작업 · 환불 · 예약건환불만 올라갑니다'}</small></span>
        <span class="module-chip restricted">지정 인원 전용</span>
      </div>
      <div class="module-section-body">
        ${showCost && missing.length ? `<div class="cost-alert">
          <span class="cost-alert-icon" aria-hidden="true">!</span>
          <span class="cost-alert-copy"><strong>회사 원가를 넣어야 할 접수 ${esc(missing.length.toLocaleString('ko-KR'))}건</strong><br>상시변동 상품이라 단가표에 원가가 없습니다. 넣기 전까지 회사 영업이익과 공급사 지불액에서 빠집니다.</span>
          <button class="module-action primary" type="button" data-cost-fill>원가 입력</button>
        </div>` : ''}
        <div class="ledger-filter">
          <label class="ledger-filter-field">
            <span>기간</span>
            <span class="ledger-filter-range">
              <input type="date" data-final-filter="from" value="${esc(finalFilter.from)}" aria-label="시작일">
              <em>~</em>
              <input type="date" data-final-filter="to" value="${esc(finalFilter.to)}" aria-label="종료일">
            </span>
          </label>
          <label class="ledger-filter-field">
            <span>영업자</span>
            <select data-final-filter="manager">
              <option value="">전체</option>
              ${managers.map(name => `<option value="${esc(name)}" ${name === finalFilter.manager ? 'selected' : ''}>${esc(name)}</option>`).join('')}
              <option value="none" ${finalFilter.manager === 'none' ? 'selected' : ''}>${esc(NO_MANAGER)}</option>
            </select>
          </label>
          ${finalFilterActive() ? '<button class="module-action" type="button" data-final-filter-reset>조건 해제</button>' : ''}
          <button class="module-action primary" type="button" data-final-assign ${rows.length ? '' : 'disabled'}>담당자 지정</button>
        </div>
        ${days.length ? days.map(([date, dayRows]) => {
          const day = finalTotals(dayRows);
          const dow = weekday[new Date(`${date}T00:00:00`).getDay()] || '';
          return `<div class="ledger-day">
            <div class="ledger-day-head">
              <strong>${esc(date.slice(5).replace('-', '/'))} (${esc(dow)}) · ${esc(dayRows.length.toLocaleString('ko-KR'))}건</strong>
              <span>판매가액 ${esc(day.sales.toLocaleString('ko-KR'))} · 영업자이익 <em>${esc(day.salesProfit.toLocaleString('ko-KR'))}</em>${showCost
                ? ` · 회사이익 <em>${esc(day.companyProfit.toLocaleString('ko-KR'))}</em>${day.vendorUnpaid ? ` · 공급사 미정산 <em class="unpaid">${esc(day.vendorUnpaid.toLocaleString('ko-KR'))}</em>` : ' · 공급사 정산완료'}`
                : ''}</span>
            </div>
            ${finalDayTable(dayRows)}
          </div>`;
        }).join('') : `<p class="sales-state">${finalFilterActive() ? '조회한 기간에 접수가 없습니다.' : '최종정산서에 올릴 접수가 아직 없습니다.'}</p>`}

        ${rows.length ? `
        <div class="sales-table-scroll">
          <table class="sales-table final-table">
            <thead>
              <tr>
                <th scope="col">구분</th>
                <th scope="col">건수</th>
                <th scope="col">수량</th>
                <th scope="col">매출</th>
                ${showCost ? '<th scope="col">회사 공급가</th>' : ''}
                <th scope="col">영업이익(영업자)</th>
                ${showCost ? '<th scope="col">영업이익(회사)</th>' : ''}
              </tr>
            </thead>
            <tbody>
              ${buckets.map(([label, match]) => {
                const part = rows.filter(match);
                const sum = finalTotals(part);
                const qty = part.reduce((acc, row) => acc + (Number(row.qty) || 0) * signOf(row), 0);
                return `<tr class="${part.length ? '' : 'ledger-empty-row'}">
                  <th scope="row">${esc(label)}</th>
                  <td>${esc(part.length.toLocaleString('ko-KR'))}</td>
                  <td>${esc(qty.toLocaleString('ko-KR'))}</td>
                  <td>${esc(sum.sales.toLocaleString('ko-KR'))}</td>
                  ${showCost ? `<td>${esc(sum.vendorDue.toLocaleString('ko-KR'))}</td>` : ''}
                  <td class="sales-cell-total">${esc(sum.salesProfit.toLocaleString('ko-KR'))}</td>
                  ${showCost ? `<td class="sales-cell-total">${esc(sum.companyProfit.toLocaleString('ko-KR'))}</td>` : ''}
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        <div class="final-total">
          <span>${finalFilterActive() ? '조회 합계' : '전체 합계'}</span>
          <span>판매가액 <strong>${esc(final.sales.toLocaleString('ko-KR'))}</strong></span>
          ${showCost ? `<span>회사 공급가 <strong>${esc(final.vendorDue.toLocaleString('ko-KR'))}</strong></span>` : ''}
          <span>영업자이익 <strong class="profit">${esc(final.salesProfit.toLocaleString('ko-KR'))}</strong></span>
          ${showCost ? `<span>회사이익 <strong class="profit">${esc(final.companyProfit.toLocaleString('ko-KR'))}</strong></span>` : ''}
          <span>입금 <strong>${esc(total.paid.toLocaleString('ko-KR'))}</strong></span>
          <span>미입금 <strong class="unpaid">${esc(Math.max(0, total.sales - total.paid).toLocaleString('ko-KR'))}</strong></span>
          ${showCost ? `<span>공급사 미정산 <strong class="unpaid">${esc(final.vendorUnpaid.toLocaleString('ko-KR'))}</strong></span>` : ''}
        </div>
        ${showCost && final.variable ? `<p class="sales-basis">원가가 상시변동인 ${esc(String(final.variable))}건은 회사 공급가를 알 수 없어 회사이익과 공급사 미정산에서 빠져 있습니다.</p>` : ''}` : ''}
        <p class="sales-basis">예약최초건 ${esc(held.length.toLocaleString('ko-KR'))}건(예약금 잔여 ${esc(heldAmount.toLocaleString('ko-KR'))}원)은 아직 일이 들어가지 않아 최종정산서에 올리지 않습니다. 예약건 작업으로 넘어갈 때 매출로 잡힙니다.</p>
        <p class="sales-basis">지금은 이 브라우저에 저장된 접수만 집계합니다. 서버 저장을 붙이면 전 영업자 기준으로 합산됩니다.</p>
      </div>
    </section>

    <section class="module-section vendor-settlement">
      <div class="module-section-head">
        <span><strong>공급사 정산</strong><small>공급처별로 수량을 맞춰 보고 지불할 금액을 확정합니다</small></span>
        <span class="module-chip ${vendorDue ? 'restricted' : 'live'}">미지불 ${esc(vendorDue.toLocaleString('ko-KR'))}원</span>
      </div>
      <div class="module-section-body">
        ${vendors.length ? `
        <div class="sales-table-scroll">
          <table class="sales-table vendor-table">
            <thead>
              <tr>
                <th scope="col">공급처</th>
                <th scope="col">접수</th>
                <th scope="col">총 수량</th>
                <th scope="col">지불할 금액</th>
                <th scope="col">지불 완료</th>
                <th scope="col">정산자</th>
                <th scope="col">미지불</th>
                <th scope="col" aria-label="정산"></th>
              </tr>
            </thead>
            <tbody>
              ${vendors.map(group => `<tr class="${group.open ? '' : 'vendor-done'}">
                <th scope="row">${esc(group.supplier)}</th>
                <td>${esc(group.rows.length.toLocaleString('ko-KR'))}건${group.variable ? `<span class="vendor-note">상시변동 ${esc(String(group.variable))}건</span>` : ''}</td>
                <td>${esc(group.qty.toLocaleString('ko-KR'))}</td>
                <td>${esc(group.due.toLocaleString('ko-KR'))}</td>
                <td>${esc(group.settledDue.toLocaleString('ko-KR'))}${group.banks.length ? `<span class="vendor-note">${esc(group.banks.join(' · '))}</span>` : ''}</td>
                <td class="${group.settledBy.length ? '' : 'ledger-memo-empty'}">${group.settledBy.length ? esc(group.settledBy.join(' · ')) : '—'}</td>
                <td class="sales-cell-total">${esc(group.openDue.toLocaleString('ko-KR'))}</td>
                <td><button class="vendor-settle" type="button" data-vendor-settle="${esc(group.supplier)}">${group.open ? '정산하기' : '내역 보기'}</button></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <p class="sales-basis">지불할 금액은 회사 원가 × 수량입니다. 단가가 상시변동인 상품은 원가가 정해져 있지 않아 금액에서 빠지며, 정산할 때 직접 넣어야 합니다.</p>
        ` : '<p class="sales-state">공급사 정산할 접수가 아직 없습니다.</p>'}
      </div>
    </section>`;
  }

  function renderFinalSettlementModule() {
    if (!canSeeFinalSettlement()) {
      moduleView.innerHTML = `
        ${moduleStatusbar('최종정산서', '지정된 인원만 볼 수 있습니다.', '접근 제한')}
        <section class="module-section">
          <div class="module-section-head">
            <span><strong>열람 권한이 없습니다</strong><small>최종정산서는 지정된 인원에게만 열립니다</small></span>
            <span class="module-chip restricted">지정 인원 전용</span>
          </div>
          <div class="module-section-body">
            <p class="sales-state">대표 · 손명아 실장 · 김대호 부장 · 박종원 부장 · 전현우 팀장만 볼 수 있습니다.</p>
          </div>
        </section>`;
      return;
    }
    if (!settlementAvailable()) {
      moduleView.innerHTML = `
        ${moduleStatusbar('최종정산서', `${currentBranchName()} 정산 체계는 따로 준비합니다.`, '본사 먼저 적용')}
        <section class="module-section">
          <div class="module-section-head">
            <span><strong>${esc(currentBranchName())} 최종정산서</strong><small>지사는 본사와 상품·단가가 달라 따로 만듭니다</small></span>
            <span class="module-chip">준비 중</span>
          </div>
          <div class="module-section-body">
            <p class="sales-state">본사 최종정산서를 먼저 완성한 뒤 ${esc(currentBranchName())} 기준으로 따로 잡습니다.</p>
          </div>
        </section>`;
      return;
    }
    intakeContext = 'final-settlement';
    moduleView.innerHTML = `
      ${moduleStatusbar('최종정산서', '당일접수 · 예약건 작업 · 환불 · 예약건환불만 집계합니다.', '지정 인원 전용')}
      ${renderIntakeForm()}
      ${renderFinalSettlement()}
      <div class="module-security"><span>▣</span><span><strong>볼 수 있는 사람</strong><br>대표 · 손명아 실장 · 김대호 부장 · 박종원 부장 · 전현우 팀장. 예약최초건은 아직 일이 들어가지 않아 집계에서 빠집니다.</span></div>`;
  }

  function renderSettlementModule() {

    const teamSection = canSeeTeamSettlement() ? `
      <section class="module-section">
        <div class="module-section-head">
          <span><strong>하위 계정 정산서</strong><small>본사 영업자의 개인정산서를 열어 봅니다</small></span>
          <span class="module-chip restricted">대표 · 김대호 · 박종원</span>
        </div>
        <div class="module-section-body">
          <div class="team-roster">
            ${subordinateRoster().map(row => `<button class="team-member" type="button" data-team-member="${esc(row.name)}">
              <span class="team-member-name">${esc(row.name)}</span>
              <span class="team-member-rank">${esc(orgRankOf(row))}</span>
              <span class="team-member-team">${esc(orgDisplayName(row.teamName || row.divisionName))}</span>
            </button>`).join('')}
          </div>
          <p class="sales-basis">접수 건이 각자 브라우저에만 저장되고 있어 아직 남의 정산서를 불러올 수 없습니다. 서버 저장을 붙이면 이 목록에서 바로 열립니다.</p>
        </div>
      </section>` : '';
    if (!settlementAvailable()) {
      moduleView.innerHTML = `
        ${moduleStatusbar('개인 정산서', `${currentBranchName()} 정산 체계는 따로 준비합니다.`, '본사 먼저 적용')}
        <section class="module-section">
          <div class="module-section-head">
            <span><strong>${esc(currentBranchName())} 정산서</strong><small>지사는 접수 경로와 취급 상품이 본사와 달라 별도로 만듭니다</small></span>
            <span class="module-chip">준비 중</span>
          </div>
          <div class="module-section-body">
            <p class="sales-state">본사 정산서를 먼저 완성한 뒤 ${esc(currentBranchName())} 기준으로 따로 잡습니다. 지금은 본사 접수 화면이 열리지 않습니다.</p>
          </div>
        </section>
        <div class="module-security"><span>▣</span><span><strong>지사는 따로 봅니다</strong><br>본사·대구지사·전주지사의 상품과 단가가 서로 달라 정산 체계를 분리합니다.</span></div>`;
      return;
    }

    intakeContext = 'settlement';
    moduleView.innerHTML = `
      ${moduleStatusbar('개인 정산서', canSeeTeamSettlement() ? '시트접수와 하위 계정 정산서를 관리합니다.' : '로그인한 영업자의 개인정산 범위만 표시합니다.', '서버 저장 · 기간 조회')}
      ${renderIntakeForm()}
      ${renderIntakeLedger()}
      ${teamSection}
      <div class="module-security"><span>▣</span><span><strong>현재 적용 권한: ${esc(currentOrgRank())}</strong><br>${canSeeCompanyCost()
        ? '개인정산서는 영업자 단가 기준으로만 표시합니다. 회사 원가는 최종정산서에서만 봅니다.'
        : '영업자 단가 기준으로만 표시되며 회사 원가는 감춥니다. 지금 구글 정산서와 같은 기준입니다.'}${canSeeFinalSettlement()
        ? ' 최종정산서는 지정된 인원에게만 열립니다.'
        : ' 최종정산서는 지정된 인원만 볼 수 있어 표시하지 않습니다.'}${canSeeTeamSettlement()
        ? ' 하위 계정 정산서도 열 수 있습니다.'
        : ''}</span></div>`;
  }

  // 김지홍 월보장, 박우진 월관리, 김대호 직접실행은 표준 정산서로 안 담긴다.
  // 판매 한 줄에 실행 여러 줄이 마이너스로 붙는 구조라 따로 둔다.
  const MONTHLY_TABS = {
    'monthly-guarantee': {
      label: '월보장 정산서',
      owner: '김지홍',
      saleLabel: '월보장 판매',
      saleHint: '월보장으로 받은 금액을 한 줄로 넣습니다',
      runHint: '그 월보장에 들어간 원고·작업 비용을 붙입니다',
      period: false
    },
    'monthly-manage': {
      label: '월관리 정산서',
      owner: '박우진',
      saleLabel: '월관리 판매',
      saleHint: '월 관리비를 한 줄로 넣습니다',
      runHint: '주차별로 실행한 리워드·블로그 비용을 붙입니다',
      period: true
    },
    'direct-execution': {
      label: '직접실행 정산서',
      owner: '김대호',
      saleLabel: '직접실행 매출',
      saleHint: '직접 실행할 판매 금액을 한 줄로 넣습니다',
      runHint: '해당 판매 건에 직접 실행한 상품과 비용을 붙입니다',
      period: false
    }
  };

  let monthlyDraft = {};
  let monthlyForm = { view: '', parentId: '', date: '', client: '', a: '', b: '', c: '', qty: '', amount: '', period: '', memo: '' };
  let finalExecutionState = { status: 'idle', rows: [], error: '' };
  let finalExecutionFilter = { from: '', to: '', view: '' };

  function monthlyStorageKey(view) {
    return `peakos.monthly.${view}.${previewPersona || userDoc?.uid || 'anon'}`;
  }

  function localMonthlyDraft(view) {
    try {
      const saved = JSON.parse(localStorage.getItem(monthlyStorageKey(view)) || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch (error) {
      return [];
    }
  }

  async function loadMonthlyDraft() {
    monthlyDraft = {};
    await Promise.all(Object.keys(MONTHLY_TABS).map(async view => {
      if (!canSeeMonthly(view)) { monthlyDraft[view] = []; return; }
      try {
        const rows = await readOnlyApi(`/peakos/monthly/${view}`);
        monthlyDraft[view] = Array.isArray(rows) ? rows : [];
      } catch (error) {
        monthlyDraft[view] = [];
      }
    }));
  }

  async function loadFinalExecutionSettlement() {
    if (!canSeeFinalExecutionSettlement()) {
      finalExecutionState = { status: 'idle', rows: [], error: '' };
      return;
    }
    finalExecutionState = { status: 'loading', rows: [], error: '' };
    try {
      const payload = await readOnlyApi('/peakos/final-execution');
      finalExecutionState = {
        status: 'ready',
        rows: Array.isArray(payload?.rows) ? payload.rows : [],
        error: ''
      };
    } catch (error) {
      finalExecutionState = { status: 'error', rows: [], error: error.message || '자료를 불러오지 못했습니다.' };
    }
  }

  async function saveMonthlyDraft(view, rows) {
    const list = (rows && rows.length ? rows : monthlyRows(view)).filter(Boolean);
    if (!list.length || !canManageMonthly(view)) return false;
    try {
      await callApi('POST', `/peakos/monthly/${view}`, { rows: list });
      if (canSeeFinalExecutionSettlement()) await loadFinalExecutionSettlement();
      return true;
    } catch (error) {
      console.error('정산 저장 실패:', error.message);
      showToast(`저장하지 못했습니다. ${error.message}`);
      return false;
    }
  }

  async function removeMonthlyRow(view, id) {
    if (!canManageMonthly(view)) return false;
    try {
      await callApi('DELETE', `/peakos/monthly/${view}/${encodeURIComponent(id)}`);
      if (canSeeFinalExecutionSettlement()) await loadFinalExecutionSettlement();
      return true;
    } catch (error) {
      console.error('정산 삭제 실패:', error.message);
      showToast(`지우지 못했습니다. ${error.message}`);
      return false;
    }
  }

  // 이 세 정산서는 직급 상속 예외다. 서버가 /users/me에 내려준 UID 권한으로
  // 소유자 본인에게만 열고, 계정 미리보기에서는 항상 닫는다.
  function canSeeMonthly(view) {
    const config = MONTHLY_TABS[view];
    if (!config || previewPersona) return false;
    const allowedViews = userDoc?.peakos_special_settlement_views;
    if (Array.isArray(allowedViews)) return allowedViews.includes(view);
    // 서버와 화면의 순차 배포 중에도 타인에게 넓어지지 않는 보수적 fallback.
    return String(userDoc?.name || '').trim() === config.owner;
  }

  // 조회와 편집 모두 같은 본인 전용 capability를 사용한다.
  function canManageMonthly(view) {
    return canSeeMonthly(view);
  }

  function monthlyRows(view) {
    return monthlyDraft[view] || [];
  }

  function monthlySales(view) {
    return monthlyRows(view).filter(row => row.kind === 'sale');
  }

  function monthlyRuns(view, saleId) {
    return monthlyRows(view).filter(row => row.kind === 'run' && row.parentId === saleId);
  }

  // 묶음 하나의 손익. 판매액에서 실행분을 뺀다.
  function monthlyGroupTotals(view, sale) {
    const runs = monthlyRuns(view, sale.id);
    const cost = runs.reduce((sum, row) => sum + (Number(row.amount) || 0) * (Number(row.qty) || 0), 0);
    const sales = Number(sale.amount) || 0;
    return { runs, cost, sales, profit: sales - cost };
  }

  function monthlyTotals(view) {
    return monthlySales(view).reduce((sum, sale) => {
      const group = monthlyGroupTotals(view, sale);
      sum.sales += group.sales;
      sum.cost += group.cost;
      sum.profit += group.profit;
      sum.runs += group.runs.length;
      return sum;
    }, { sales: 0, cost: 0, profit: 0, runs: 0 });
  }

  function renderMonthlyForm(view) {
    const config = MONTHLY_TABS[view];
    const form = monthlyForm.view === view ? monthlyForm : { ...monthlyForm, view, parentId: '', a: '', b: '', c: '' };
    monthlyForm = form;
    const sales = monthlySales(view);
    const isRun = Boolean(form.parentId);
    const parent = isRun ? sales.find(sale => sale.id === form.parentId) : null;
    const majors = priceLevels('a');
    const middles = form.a ? priceLevels('b', form.a) : [];
    const minors = form.a && form.b ? priceLevels('c', form.a, form.b) : [];
    const option = (value, selected) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(value)}</option>`;

    return `<section class="module-section" data-monthly-form>
      <div class="module-section-head">
        <span><strong>${esc(config.label)} ${isRun ? '실행비 등록' : '등록'}</strong><small>${esc(isRun && parent ? `${parent.client || '업체 미입력'} · ${parent.date} 매출에 실행비를 추가합니다` : config.saleHint)}</small></span>
        <span class="intake-head-right">
          <span class="module-chip live">${esc(isRun ? '실행비' : config.saleLabel)}</span>
          ${isRun ? '<button class="module-action" type="button" data-monthly-sale-mode>새 매출 등록으로 돌아가기</button>' : ''}
        </span>
      </div>
      <div class="module-section-body">
        <div class="intake-form">
          <label class="intake-field">
            <span>일자</span>
            <input type="date" data-monthly="date" value="${esc(form.date || localDateKey(new Date()))}">
          </label>
          <label class="intake-field ${isRun ? 'auto' : ''}">
            <span>업체명</span>
            <input type="text" data-monthly="client" value="${esc(form.client)}" placeholder="업체명" ${isRun ? 'readonly' : ''}>
          </label>
          <label class="intake-field">
            <span>대분류</span>
            <select data-monthly="a">${[''].concat(majors).map(v => option(v, form.a)).join('')}</select>
          </label>
          <label class="intake-field">
            <span>중분류</span>
            <select data-monthly="b">${[''].concat(middles).map(v => option(v, form.b)).join('')}</select>
          </label>
          <label class="intake-field">
            <span>소분류</span>
            <select data-monthly="c">${[''].concat(minors).map(v => option(v, form.c)).join('')}</select>
          </label>
          <label class="intake-field">
            <span>${isRun ? '실행가' : '판매가액'}</span>
            <input type="number" min="0" data-monthly="amount" value="${esc(form.amount)}" placeholder="0">
          </label>
          <label class="intake-field">
            <span>수량</span>
            <input type="number" min="1" data-monthly="qty" value="${esc(form.qty)}" placeholder="${isRun ? '0' : '1'}">
          </label>
          ${config.period ? `<label class="intake-field">
            <span>구동 기간</span>
            <input type="text" data-monthly="period" value="${esc(form.period)}" placeholder="${isRun ? '1주차 : 05/08 ~ 05/14' : '05/08 ~ 06/04 구동'}">
          </label>` : ''}
        </div>
        <label class="intake-field wide">
          <span>특이사항</span>
          <input type="text" data-monthly="memo" value="${esc(form.memo)}" placeholder="메모">
        </label>
        <div class="intake-foot">
          <p class="sales-basis">${esc(isRun ? '실행비는 영업이익에서 빠집니다.' : `${config.saleLabel}은 영업이익에 더해집니다.`)} 서버 저장 후 최종실행정산서에 자동 반영됩니다.</p>
          <button class="module-action primary" type="button" data-monthly-add>${esc(isRun ? '실행비 추가' : `${config.saleLabel} 등록`)}</button>
        </div>
      </div>
    </section>`;
  }

  function renderMonthlyLedger(view) {
    const config = MONTHLY_TABS[view];
    const sales = monthlySales(view);
    const total = monthlyTotals(view);
    const editable = canManageMonthly(view);
    if (!sales.length) {
      return `<section class="module-section">
        <div class="module-section-head"><span><strong>${esc(config.label)}</strong><small>${esc(config.owner)} 기준</small></span></div>
        <div class="module-section-body"><p class="sales-state">아직 등록한 ${esc(config.saleLabel)}이 없습니다.${editable ? ' 위에서 등록해 보세요.' : ''}</p></div>
      </section>`;
    }

    return `<section class="module-section monthly-ledger">
      <div class="module-section-head">
        <span><strong>${esc(config.label)}</strong><small>${esc(config.owner)} · ${esc(String(sales.length))}건 · 실행 ${esc(String(total.runs))}건</small></span>
        <span class="module-chip live">판매 ${esc(total.sales.toLocaleString('ko-KR'))}원 · 영업이익 ${esc(total.profit.toLocaleString('ko-KR'))}원</span>
      </div>
      <div class="module-section-body">
        ${sales.map(sale => {
          const group = monthlyGroupTotals(view, sale);
          return `<div class="monthly-group">
            <div class="monthly-head">
              <span class="monthly-title"><strong>${esc(sale.client || '업체 미입력')}</strong><small>${esc(sale.date.slice(5).replace('-', '/'))} · ${esc(sale.a)} › ${esc(sale.b)} › ${esc(sale.c)}${sale.period ? ` · ${esc(sale.period)}` : ''}</small></span>
              <span class="monthly-sums">
                <span>판매 <strong>${esc(group.sales.toLocaleString('ko-KR'))}</strong></span>
                <span>실행 <strong>${esc(group.cost.toLocaleString('ko-KR'))}</strong></span>
                <span>영업이익 <strong class="profit">${esc(group.profit.toLocaleString('ko-KR'))}</strong></span>
                ${editable ? `<button class="module-action" type="button" data-monthly-run="${esc(sale.id)}">실행비 추가</button>` : ''}
                ${editable ? `<button class="ledger-remove" type="button" data-monthly-remove="${esc(sale.id)}" aria-label="${esc(sale.client || '')} 묶음 삭제">✕</button>` : ''}
              </span>
            </div>
            ${group.runs.length ? `<div class="sales-table-scroll">
              <table class="sales-table monthly-table">
                <thead><tr>
                  <th scope="col">일자</th><th scope="col">상품</th><th scope="col">실행가</th>
                  <th scope="col">수량</th><th scope="col">실행 공급가액</th>
                  ${config.period ? '<th scope="col">구동 기간</th>' : ''}
                  <th scope="col">특이사항</th>${editable ? '<th scope="col" aria-label="삭제"></th>' : ''}
                </tr></thead>
                <tbody>
                  ${group.runs.map(run => `<tr>
                    <td>${esc(run.date.slice(5).replace('-', '/'))}</td>
                    <th scope="row">${esc(run.b)} › ${esc(run.c)}</th>
                    <td>${esc(Number(run.amount).toLocaleString('ko-KR'))}</td>
                    <td>${esc(Number(run.qty).toLocaleString('ko-KR'))}</td>
                    <td class="monthly-minus">-${esc(((Number(run.amount) || 0) * (Number(run.qty) || 0)).toLocaleString('ko-KR'))}</td>
                    ${config.period ? `<td>${run.period ? esc(run.period) : '<span class="ledger-memo-empty">—</span>'}</td>` : ''}
                    <td class="ledger-memo">${run.memo ? esc(run.memo) : '<span class="ledger-memo-empty">—</span>'}</td>
                    ${editable ? `<td><button class="ledger-remove" type="button" data-monthly-remove="${esc(run.id)}" aria-label="실행 건 삭제">✕</button></td>` : ''}
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>` : '<p class="sales-basis monthly-empty">등록된 실행비가 없습니다. 이 매출의 ‘실행비 추가’ 버튼으로 입력할 수 있습니다.</p>'}
          </div>`;
        }).join('')}
        <div class="ledger-total">
          <span>합계</span>
          <span>판매 <strong>${esc(total.sales.toLocaleString('ko-KR'))}</strong></span>
          <span>실행 <strong>${esc(total.cost.toLocaleString('ko-KR'))}</strong></span>
          <span>영업이익 <strong class="profit">${esc(total.profit.toLocaleString('ko-KR'))}</strong></span>
        </div>
      </div>
    </section>`;
  }

  function renderMonthlyModule(view) {
    const config = MONTHLY_TABS[view];
    if (!canSeeMonthly(view)) {
      moduleView.innerHTML = `
        ${moduleStatusbar(config.label, '지정된 인원만 볼 수 있습니다.', '접근 제한')}
        <section class="module-section">
          <div class="module-section-head">
            <span><strong>열람 권한이 없습니다</strong><small>${esc(config.owner)} 본인만 볼 수 있습니다</small></span>
            <span class="module-chip restricted">지정 인원 전용</span>
          </div>
          <div class="module-section-body"><p class="sales-state">권한이 있는 로그인 계정으로 다시 확인해 주세요.</p></div>
        </section>`;
      return;
    }
    moduleView.innerHTML = `
      ${view === 'direct-execution' ? '' : moduleStatusbar(config.label, `${config.saleLabel} 한 건에 실행 비용을 붙여 묶음별로 손익을 봅니다.`, `${config.owner} 본인 전용`)}
      ${renderMonthlyForm(view)}
      ${renderMonthlyLedger(view)}
      <div class="module-security"><span>▣</span><span><strong>${esc(config.owner)} 본인만 볼 수 있고 수정할 수 있습니다</strong><br>${esc(config.label)}은 판매 한 건에 실행 여러 건이 붙는 구조라 개인정산서·최종정산서와 섞지 않습니다.</span></div>`;
  }

  function finalExecutionGroups() {
    const rows = finalExecutionState.rows.filter(row => MONTHLY_TABS[row.view]);
    const saleIds = new Set(rows.filter(row => row.kind === 'sale').map(row => `${row.view}|${row.id}`));
    const orphans = rows.filter(row => row.kind === 'run' && !saleIds.has(`${row.view}|${row.parentId}`));
    const groups = rows
      .filter(row => row.kind === 'sale')
      .map(sale => {
        const runs = rows.filter(row => row.kind === 'run' && row.view === sale.view && row.parentId === sale.id);
        const sales = Number(sale.amount) || 0;
        const cost = runs.reduce((sum, row) => sum + (Number(row.amount) || 0) * (Number(row.qty) || 0), 0);
        return { sale, runs, sales, cost, profit: sales - cost };
      })
      .sort((left, right) => String(right.sale.date).localeCompare(String(left.sale.date)));
    return { groups, orphans };
  }

  function finalExecutionTotals(groups) {
    return groups.reduce((sum, group) => {
      sum.sales += group.sales;
      sum.cost += group.cost;
      sum.profit += group.profit;
      sum.runs += group.runs.length;
      return sum;
    }, { sales: 0, cost: 0, profit: 0, runs: 0 });
  }

  function renderFinalExecutionSettlementModule() {
    if (!canSeeFinalExecutionSettlement()) {
      moduleView.innerHTML = `
        ${moduleStatusbar('최종실행정산서', '지정된 네 계정만 볼 수 있습니다.', '접근 제한')}
        <section class="module-section"><div class="module-section-body"><p class="sales-state">최종실행정산서 열람 권한이 없습니다.</p></div></section>`;
      return;
    }
    if (finalExecutionState.status === 'loading' || finalExecutionState.status === 'idle') {
      moduleView.innerHTML = `
        ${moduleStatusbar('최종실행정산서', '월보장·월관리·직접실행 정산서를 취합합니다.', '불러오는 중')}
        <section class="module-section"><div class="module-section-body"><p class="sales-state">최종실행정산서를 불러오고 있습니다.</p></div></section>`;
      return;
    }
    if (finalExecutionState.status === 'error') {
      moduleView.innerHTML = `
        ${moduleStatusbar('최종실행정산서', '월보장·월관리·직접실행 정산서를 취합합니다.', '조회 실패')}
        <section class="module-section"><div class="module-section-body"><p class="sales-state">${esc(finalExecutionState.error)}</p><button class="module-action" type="button" data-final-execution-refresh>다시 조회</button></div></section>`;
      return;
    }

    const { groups: allGroups, orphans } = finalExecutionGroups();
    const groups = allGroups.filter(group => {
      if (finalExecutionFilter.from && String(group.sale.date) < finalExecutionFilter.from) return false;
      if (finalExecutionFilter.to && String(group.sale.date) > finalExecutionFilter.to) return false;
      if (finalExecutionFilter.view && group.sale.view !== finalExecutionFilter.view) return false;
      return true;
    });
    const total = finalExecutionTotals(groups);
    const filterActive = Boolean(finalExecutionFilter.from || finalExecutionFilter.to || finalExecutionFilter.view);
    const sourceMarkup = Object.entries(MONTHLY_TABS).map(([view, config]) => {
      const sourceGroups = groups.filter(group => group.sale.view === view);
      if (finalExecutionFilter.view && finalExecutionFilter.view !== view) return '';
      const sourceTotal = finalExecutionTotals(sourceGroups);
      return `<section class="module-section final-execution-source" data-final-execution-source="${esc(view)}">
        <div class="module-section-head">
          <span><strong>${esc(config.label)}</strong><small>${esc(config.owner)} · 매출 ${esc(String(sourceGroups.length))}건 · 실행 ${esc(String(sourceTotal.runs))}건</small></span>
          <span class="module-chip live">판매 ${esc(sourceTotal.sales.toLocaleString('ko-KR'))}원 · 실행 ${esc(sourceTotal.cost.toLocaleString('ko-KR'))}원 · 이익 ${esc(sourceTotal.profit.toLocaleString('ko-KR'))}원</span>
        </div>
        <div class="module-section-body">
          ${sourceGroups.length ? sourceGroups.map(group => `<div class="monthly-group">
            <div class="monthly-head">
              <span class="monthly-title"><strong>${esc(group.sale.client || '업체 미입력')}</strong><small>${esc(group.sale.date)} · ${esc(group.sale.a)} › ${esc(group.sale.b)} › ${esc(group.sale.c)}${group.sale.period ? ` · ${esc(group.sale.period)}` : ''}</small></span>
              <span class="monthly-sums"><span>판매 <strong>${esc(group.sales.toLocaleString('ko-KR'))}</strong></span><span>실행 <strong>${esc(group.cost.toLocaleString('ko-KR'))}</strong></span><span>영업이익 <strong class="profit">${esc(group.profit.toLocaleString('ko-KR'))}</strong></span></span>
            </div>
            ${group.runs.length ? `<div class="sales-table-scroll"><table class="sales-table monthly-table">
              <thead><tr><th scope="col">실행일</th><th scope="col">실행 상품</th><th scope="col">실행가</th><th scope="col">수량</th><th scope="col">실행 공급가액</th><th scope="col">구동 기간</th><th scope="col">특이사항</th></tr></thead>
              <tbody>${group.runs.map(run => `<tr><td>${esc(run.date)}</td><th scope="row">${esc(run.b)} › ${esc(run.c)}</th><td>${esc(Number(run.amount || 0).toLocaleString('ko-KR'))}</td><td>${esc(Number(run.qty || 0).toLocaleString('ko-KR'))}</td><td class="monthly-minus">-${esc(((Number(run.amount) || 0) * (Number(run.qty) || 0)).toLocaleString('ko-KR'))}</td><td>${run.period ? esc(run.period) : '<span class="ledger-memo-empty">—</span>'}</td><td class="ledger-memo">${run.memo ? esc(run.memo) : '<span class="ledger-memo-empty">—</span>'}</td></tr>`).join('')}</tbody>
            </table></div>` : '<p class="sales-basis monthly-empty">등록된 실행비가 없습니다.</p>'}
          </div>`).join('') : `<p class="sales-state">${filterActive ? '조회 조건에 맞는 매출이 없습니다.' : `등록된 ${esc(config.saleLabel)}이 없습니다.`}</p>`}
        </div>
      </section>`;
    }).join('');

    moduleView.innerHTML = `
      ${moduleStatusbar('최종실행정산서', '월보장·월관리·직접실행 정산서를 원본 그대로 실시간 취합합니다.', '읽기 전용')}
      <section class="module-section">
        <div class="module-section-head"><span><strong>취합 조건</strong><small>매출 일자와 정산서 종류로 조회합니다</small></span><span class="module-chip restricted">지정 4계정 전용</span></div>
        <div class="module-section-body">
          <div class="ledger-filter">
            <label class="ledger-filter-field"><span>기간</span><span class="ledger-filter-range"><input type="date" data-final-execution-filter="from" value="${esc(finalExecutionFilter.from)}" aria-label="최종실행 시작일"><em>~</em><input type="date" data-final-execution-filter="to" value="${esc(finalExecutionFilter.to)}" aria-label="최종실행 종료일"></span></label>
            <label class="ledger-filter-field"><span>정산서</span><select data-final-execution-filter="view"><option value="">전체</option>${Object.entries(MONTHLY_TABS).map(([view, config]) => `<option value="${esc(view)}" ${finalExecutionFilter.view === view ? 'selected' : ''}>${esc(config.label)} · ${esc(config.owner)}</option>`).join('')}</select></label>
            ${filterActive ? '<button class="module-action" type="button" data-final-execution-reset>조건 해제</button>' : ''}
            <button class="module-action" type="button" data-final-execution-refresh>새로고침</button>
          </div>
        </div>
      </section>
      <section class="fund-cards final-execution-kpis" aria-label="최종실행정산 합계">
        <article class="fund-card"><span>판매 합계</span><strong>${esc(total.sales.toLocaleString('ko-KR'))}원</strong><small>${esc(String(groups.length))}개 매출</small></article>
        <article class="fund-card warn"><span>실행비 합계</span><strong>${esc(total.cost.toLocaleString('ko-KR'))}원</strong><small>${esc(String(total.runs))}개 실행</small></article>
        <article class="fund-card strong"><span>최종 영업이익</span><strong>${esc(total.profit.toLocaleString('ko-KR'))}원</strong><small>판매 − 실행비</small></article>
      </section>
      ${orphans.length ? `<div class="module-security"><span>!</span><span><strong>연결이 누락된 실행비 ${esc(String(orphans.length))}건</strong><br>원본 매출을 찾을 수 없어 합계에서 제외했습니다. 개발자에게 확인을 요청해 주세요.</span></div>` : ''}
      ${sourceMarkup}
      <div class="module-security"><span>▣</span><span><strong>${esc(FINAL_EXECUTION_SETTLEMENT_VIEWERS.join(' · '))}만 볼 수 있습니다</strong><br>이 화면은 읽기 전용이며 원본 수정은 각 담당자의 월보장·월관리·직접실행 정산서에서만 가능합니다.</span></div>`;
  }

  // 입금체크 — 개인정산서에 흩어진 입금 상태를 한 화면에 모은다.
  let depositFilter = { state: 'unpaid', client: '' };

  function reviewedIntakeRows() {
    // 전체 검토 목록은 로그인 직후 서버 스냅샷이다. 검토자가 자기 접수를
    // 방금 추가·수정한 경우에는 현재 개인정산서의 값으로 즉시 덮어써서
    // 입금·세금 탭에서 새로고침 없이 같은 내용을 보게 한다.
    const rowsById = new Map(bankMatchReviewRows.map(row => [String(row.id || ''), row]));
    personalRows().forEach(row => rowsById.set(String(row.id || ''), row));
    return [...rowsById.values()];
  }

  function depositSourceRows() {
    return canReviewCreditRequests() ? reviewedIntakeRows() : personalRows();
  }

  function depositPeriodRows() {
    return depositSourceRows()
      .filter(row => kindOf(row) !== 'reserve')
      .filter(row => inFinancePeriod(row.date));
  }

  function depositRows() {
    return depositPeriodRows()
      .filter(row => {
        if (depositFilter.client && row.client !== depositFilter.client) return false;
        if (!depositFilter.state) return true;
        if (depositFilter.state === 'unpaid') return paidStateOf(row) !== 'paid';
        return paidStateOf(row) === depositFilter.state;
      })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }

  // 업체별 미수금. 얼마 받아야 하는지가 제일 급한 숫자다.
  function depositByClient() {
    const map = new Map();
    depositPeriodRows().forEach(row => {
      const key = row.client || '업체 미입력';
      if (!map.has(key)) map.set(key, { client: key, sales: 0, paid: 0, count: 0, open: 0 });
      const item = map.get(key);
      const sign = signOf(row);
      const sales = (Number(row.sell) || 0) * (Number(row.qty) || 0) * sign;
      item.sales += sales;
      item.paid += kindOf(row) === 'use' ? sales : (Number(row.paidAmount) || 0) * sign;
      item.count += 1;
      if (paidStateOf(row) !== 'paid' && kindOf(row) !== 'use') item.open += 1;
    });
    return [...map.values()]
      .map(item => ({ ...item, due: item.sales - item.paid }))
      .sort((a, b) => b.due - a.due);
  }

  function bankMatchEligibilityMarkup(row) {
    if (row.paidAuto) return '<span class="kind-badge added">자동 확인 완료</span>';
    if (!['normal', 'reserve'].includes(kindOf(row))) return '<span class="ledger-memo-empty">대상 아님</span>';
    if (!bankData.autoReconciliationEnabled) {
      return '<span class="kind-badge">자동 확인 보류</span>';
    }
    if (row.bankMatchEligible) {
      return `<button class="module-action" type="button" data-bank-match-eligibility="${esc(row.id)}" data-bank-match-next="false">확정 해제</button>`;
    }
    return `<button class="module-action primary" type="button" data-bank-match-eligibility="${esc(row.id)}" data-bank-match-next="true">대상 확정</button>`;
  }

  function renderDepositModule() {
    const rows = depositRows();
    const clients = depositByClient();
    const totalDue = clients.reduce((sum, item) => sum + Math.max(0, item.due), 0);
    const option = (value, label, selected) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
    const canReviewMatches = canReviewCreditRequests();

    moduleView.innerHTML = `
      ${moduleStatusbar('입금체크', '아직 안 들어온 돈을 업체별로 모아 봅니다.', `미수 ${totalDue.toLocaleString('ko-KR')}원`)}
      ${renderFinancePeriodFilter('deposit-check', '접수일 기준 · 업체별 합계와 건별 목록 동시 적용')}
      ${canReviewMatches && !bankData.autoReconciliationEnabled ? '<div class="module-security"><span>!</span><span><strong>자동 입금확인은 안전상 보류 중입니다</strong><br>통장 조회와 거래 원장 동기화는 정상 운영하며, IBK 공식 거래번호가 연결된 뒤 자동 확인·충전금 승인을 엽니다.</span></div>' : ''}

      <section class="module-section">
        <div class="module-section-head">
          <span><strong>업체별 미수금</strong><small>판매액에서 들어온 금액을 뺀 값입니다</small></span>
          <span class="module-chip ${totalDue ? 'restricted' : 'live'}">미수 ${esc(totalDue.toLocaleString('ko-KR'))}원</span>
        </div>
        <div class="module-section-body">
          ${clients.length ? `<div class="sales-table-scroll">
            <table class="sales-table">
              <thead><tr><th scope="col">업체명</th><th scope="col">접수</th><th scope="col">미입금 건</th><th scope="col">판매액</th><th scope="col">입금</th><th scope="col">미수금</th><th scope="col" aria-label="조회"></th></tr></thead>
              <tbody>
                ${clients.map(item => `<tr class="${item.due > 0 ? '' : 'vendor-done'}">
                  <th scope="row">${esc(item.client)}</th>
                  <td>${esc(item.count.toLocaleString('ko-KR'))}건</td>
                  <td>${esc(item.open.toLocaleString('ko-KR'))}건</td>
                  <td>${esc(item.sales.toLocaleString('ko-KR'))}</td>
                  <td>${esc(item.paid.toLocaleString('ko-KR'))}</td>
                  <td class="${item.due > 0 ? 'monthly-minus' : 'sales-cell-total'}">${esc(item.due.toLocaleString('ko-KR'))}</td>
                  <td><button class="module-action" type="button" data-deposit-client="${esc(item.client)}">건별 보기</button></td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>` : '<p class="sales-state">접수한 건이 아직 없습니다.</p>'}
        </div>
      </section>

      <section class="module-section">
        <div class="module-section-head">
          <span><strong>건별 입금 확인</strong><small>${depositFilter.client ? `${esc(depositFilter.client)} · ` : ''}${esc(String(rows.length))}건</small></span>
          <span class="module-chip live">묶어서 처리 가능</span>
        </div>
        <div class="module-section-body">
          <div class="ledger-filter">
            <label class="ledger-filter-field">
              <span>입금 상태</span>
              <select data-deposit-filter="state">
                ${option('unpaid', '아직 안 들어온 건', depositFilter.state)}
                ${option('', '전체', depositFilter.state)}
                ${option('none', '미입금', depositFilter.state)}
                ${option('partial', '부분입금', depositFilter.state)}
                ${option('wrong', '오입금', depositFilter.state)}
                ${option('paid', '입금 완료', depositFilter.state)}
              </select>
            </label>
            <label class="ledger-filter-field">
              <span>거래처</span>
              <select data-deposit-filter="client">
                ${option('', '전체', depositFilter.client)}
                ${clients.map(item => option(item.client, item.client, depositFilter.client)).join('')}
              </select>
            </label>
          </div>
          <div class="pick-bar-slot">${pickBarMarkup()}</div>
          ${rows.length ? `<div class="sales-table-scroll">
            <table class="sales-table ledger-table">
              <thead><tr>
                <th scope="col" aria-label="선택"></th><th scope="col">일자</th><th scope="col">업체명</th>
                ${canReviewMatches ? '<th scope="col">예상 입금자</th>' : ''}
                <th scope="col">상품</th><th scope="col">판매액</th><th scope="col">입금액</th>
                <th scope="col">미수</th><th scope="col">입금</th>${canReviewMatches ? '<th scope="col">자동 확인</th>' : ''}
              </tr></thead>
              <tbody>
                ${rows.map(row => {
                  const sign = signOf(row);
                  const sales = (Number(row.sell) || 0) * (Number(row.qty) || 0) * sign;
                  const paid = kindOf(row) === 'use' ? sales : (Number(row.paidAmount) || 0) * sign;
                  return `<tr class="${intakeSelection.includes(row.id) ? 'picked' : ''}">
                    <td class="ledger-pick"><input type="checkbox" data-intake-pick="${esc(row.id)}" ${intakeSelection.includes(row.id) ? 'checked' : ''} aria-label="${esc(row.client || '')} 선택"></td>
                    <td>${esc(row.date.slice(5).replace('-', '/'))}</td>
                    <th scope="row">${esc(row.client || '업체 미입력')}${kindOf(row) === 'normal' ? '' : `<span class="kind-badge ${esc(kindOf(row))}">${esc(kindLabel(row))}</span>`}</th>
                    ${canReviewMatches ? `<td>${esc(row.expectedPayer || row.client || '—')}</td>` : ''}
                    <td class="ledger-product">${esc(row.b)} › ${esc(row.c)}</td>
                    <td>${esc(sales.toLocaleString('ko-KR'))}</td>
                    <td>${esc(paid.toLocaleString('ko-KR'))}</td>
                    <td class="${sales - paid > 0 ? 'monthly-minus' : ''}">${esc((sales - paid).toLocaleString('ko-KR'))}</td>
                    <td>${renderPaidCell(row)}</td>
                    ${canReviewMatches ? `<td>${bankMatchEligibilityMarkup(row)}</td>` : ''}
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>` : '<p class="sales-state">조회 조건에 맞는 건이 없습니다.</p>'}
        </div>
      </section>

      <div class="module-security"><span>▣</span><span><strong>정확히 확인되는 입금만 자동 처리합니다</strong><br>매출통장의 금액과 예상 입금자명이 모두 같고 후보가 한 건일 때만 자동 확인합니다. 부분입금·묶음입금·이름이 다른 건은 수기로 확인합니다.</span></div>`;
  }

  // 충전금 — 포인트로 받는 업체는 얼마 입금했고 얼마 충전했는지를 따로 적는다.
  // 시트의 '충전금 입금내역'·'스페이스 충전금' 탭 구조를 그대로 옮겼다.
  const CREDIT_KINDS = { charge: '충전', use: '차감', refund: '환불' };
  const CREDIT_REQUEST_ACCOUNTS = {
    'ibk-review-space': '리뷰스페이스통장',
    'ibk-reward-space': '리워드스페이스통장'
  };
  const CREDIT_REQUEST_STATUS = {
    PENDING: '입금 대기',
    APPROVED: '자동 승인',
    CANCELLED: '취소'
  };
  let creditDraft = [];
  let creditForm = { date: '', client: '', product: '', vendor: '', kind: 'charge', paid: '', point: '', memo: '' };
  let creditRequests = [];
  let creditRequestScope = 'mine';
  let creditRequestForm = {
    targetAccountId: 'ibk-review-space',
    requestDate: '',
    client: '',
    depositorName: '',
    product: '',
    vendor: '',
    expectedAmount: '',
    pointAmount: '',
    memo: ''
  };

  function creditStorageKey() {
    return `peakos.credit.${previewPersona || userDoc?.uid || 'anon'}`;
  }

  function localCreditDraft() {
    try {
      const saved = JSON.parse(localStorage.getItem(creditStorageKey()) || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch (error) {
      return [];
    }
  }

  async function loadCreditDraft() {
    if (previewPersona) {
      creditDraft = [];
      creditRequests = [];
      creditRequestScope = 'mine';
      return;
    }
    const ledgerPromise = canSeeFinalSettlement()
      ? readOnlyApi('/peakos/credit').then(rows => {
        creditDraft = Array.isArray(rows) ? rows : [];
      }).catch(() => { creditDraft = []; })
      : Promise.resolve().then(() => { creditDraft = []; });
    const requestedScope = canReviewCreditRequests() ? 'all' : 'mine';
    const requestPromise = readOnlyApi(`/peakos/credit-requests?scope=${requestedScope}`)
      .catch(error => {
        // 서버의 UID 권한이 최종 기준이다. 이름 기반 화면 판단과 다르면
        // 전체 목록은 버리고 본인 요청만 다시 읽는다.
        if (requestedScope === 'all' && error.status === 403) {
          return readOnlyApi('/peakos/credit-requests?scope=mine');
        }
        throw error;
      })
      .then(payload => {
        creditRequests = Array.isArray(payload?.requests) ? payload.requests : [];
        creditRequestScope = payload?.scope === 'all' ? 'all' : 'mine';
      })
      .catch(() => {
        creditRequests = [];
        creditRequestScope = 'mine';
      });
    await Promise.all([ledgerPromise, requestPromise]);
  }

  async function saveCreditRows(rows) {
    const list = (rows && rows.length ? rows : creditDraft).filter(Boolean);
    if (!list.length) return;
    try {
      await callApi('POST', '/peakos/credit', { rows: list });
    } catch (error) {
      console.error('충전금 저장 실패:', error.message);
      showToast(`저장하지 못했습니다. ${error.message}`);
    }
  }

  function saveCreditDraft() {
    saveCreditRows(creditDraft);
  }

  function creditSign(row) {
    return row.kind === 'charge' ? 1 : -1;
  }

  // 업체별 잔여 포인트와 입금액. 충전은 더하고 차감·환불은 뺀다.
  function creditByClient(rows = creditDraft) {
    const map = new Map();
    rows.forEach(row => {
      const key = row.client || '업체 미입력';
      if (!map.has(key)) map.set(key, { client: key, paid: 0, point: 0, rows: [] });
      const item = map.get(key);
      const sign = creditSign(row);
      item.paid += (Number(row.paid) || 0) * sign;
      item.point += (Number(row.point) || 0) * sign;
      item.rows.push(row);
    });
    return [...map.values()].sort((a, b) => b.point - a.point);
  }

  function renderCreditModule() {
    const allClients = creditByClient();
    const currentPoint = allClients.reduce((sum, item) => sum + item.point, 0);
    const ledgerRows = creditDraft.filter(row => inFinancePeriod(row.date));
    const clients = creditByClient(ledgerRows);
    const totalPoint = clients.reduce((sum, item) => sum + item.point, 0);
    const totalPaid = clients.reduce((sum, item) => sum + item.paid, 0);
    const requestRows = creditRequests.filter(row => inFinancePeriod(row.requestDate));
    const form = creditForm;
    const requestForm = creditRequestForm;
    const majors = priceLevels('a');
    const option = (value, label, selected) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
    const pendingCount = requestRows.filter(row => row.status === 'PENDING').length;
    const allPendingCount = creditRequests.filter(row => row.status === 'PENDING').length;
    const canSeeLedger = canSeeFinalSettlement();
    const canCancelRequest = row => row.status === 'PENDING'
      && (creditRequestScope === 'all' || String(row.requesterUid || '') === String(currentUser?.uid || ''));

    const requestMarkup = `
      <section class="module-section">
        <div class="module-section-head">
          <span><strong>충전금 요청</strong><small>입금할 통장과 입금자명·금액을 먼저 등록합니다</small></span>
          <span class="module-chip live">${creditRequestScope === 'all' ? '전체 요청 검토' : '내 요청'}</span>
        </div>
        <div class="module-section-body">
          <div class="intake-form">
            <label class="intake-field"><span>입금 통장</span>
              <select data-credit-request="targetAccountId">${Object.entries(CREDIT_REQUEST_ACCOUNTS).map(([id, label]) => option(id, label, requestForm.targetAccountId)).join('')}</select></label>
            <label class="intake-field"><span>요청일</span>
              <input type="date" data-credit-request="requestDate" value="${esc(requestForm.requestDate || localDateKey(new Date()))}"></label>
            <label class="intake-field"><span>업체명</span>
              <input type="text" data-credit-request="client" value="${esc(requestForm.client)}" maxlength="200" placeholder="업체명"></label>
            <label class="intake-field"><span>실제 입금자명</span>
              <input type="text" data-credit-request="depositorName" value="${esc(requestForm.depositorName)}" maxlength="160" placeholder="통장에 표시될 이름"></label>
            <label class="intake-field"><span>상품</span>
              <select data-credit-request="product">${[''].concat(majors).map(value => option(value, value || '선택', requestForm.product)).join('')}</select></label>
            <label class="intake-field"><span>공급처</span>
              <select data-credit-request="vendor">${[''].concat(SUPPLIERS).map(value => option(value, value || '선택', requestForm.vendor)).join('')}</select></label>
            <label class="intake-field"><span>예상 입금액</span>
              <input type="number" min="1" step="1" data-credit-request="expectedAmount" value="${esc(requestForm.expectedAmount)}" placeholder="통장에 입금될 금액"></label>
            <label class="intake-field"><span>승인할 충전금</span>
              <input type="number" min="1" step="1" data-credit-request="pointAmount" value="${esc(requestForm.pointAmount)}" placeholder="입금 확인 후 확정할 포인트"></label>
          </div>
          <label class="intake-field wide"><span>특이사항</span>
            <input type="text" data-credit-request="memo" value="${esc(requestForm.memo)}" maxlength="500" placeholder="필요한 확인 사항"></label>
          <div class="intake-foot">
            <p class="sales-basis">요청 후 실제 입금 전까지는 취소할 수 있습니다. 승인할 충전금은 요청 시 확정한 값 그대로 장부에 반영됩니다.</p>
            <button class="module-action primary" type="button" data-credit-request-submit>충전 요청</button>
          </div>
        </div>
      </section>

      <section class="module-section">
        <div class="module-section-head">
          <span><strong>${creditRequestScope === 'all' ? '전체 충전 요청' : '내 충전 요청'}</strong><small>${esc(financePeriodLabel())} · ${esc(String(requestRows.length))}건 · 입금 대기 ${esc(String(pendingCount))}건</small></span>
          <span class="module-chip ${pendingCount ? 'restricted' : 'live'}">${pendingCount ? `조회 기간 대기 ${esc(String(pendingCount))}` : '조회 기간 대기 없음'}</span>
        </div>
        <div class="module-section-body">
          ${requestRows.length ? `<div class="sales-table-scroll">
            <table class="sales-table ledger-table">
              <thead><tr><th scope="col">요청일</th>${creditRequestScope === 'all' ? '<th scope="col">요청자</th>' : ''}<th scope="col">통장</th><th scope="col">업체명</th><th scope="col">입금자명</th><th scope="col">상품 · 공급처</th><th scope="col">예상 입금액</th><th scope="col">충전금</th><th scope="col">상태</th><th scope="col" aria-label="취소"></th></tr></thead>
              <tbody>${requestRows.map(row => `<tr>
                <td>${esc(String(row.requestDate || '').slice(5).replace('-', '/'))}</td>
                ${creditRequestScope === 'all' ? `<td>${esc(row.requesterName || '—')}</td>` : ''}
                <td>${esc(CREDIT_REQUEST_ACCOUNTS[row.targetAccountId] || '지정 통장')}</td>
                <th scope="row">${esc(row.client || '—')}</th>
                <td>${esc(row.depositorName || '—')}</td>
                <td>${esc(row.product || '—')} · ${esc(row.vendor || '—')}</td>
                <td>${esc(Number(row.expectedAmount || 0).toLocaleString('ko-KR'))}</td>
                <td>${esc(Number(row.pointAmount || 0).toLocaleString('ko-KR'))}</td>
                <td><span class="kind-badge ${row.status === 'APPROVED' ? 'added' : row.status === 'CANCELLED' ? 'refund' : 'normal'}">${esc(CREDIT_REQUEST_STATUS[row.status] || row.status || '확인 중')}</span></td>
                <td>${canCancelRequest(row) ? `<button class="ledger-remove" type="button" data-credit-request-cancel="${esc(row.id)}" aria-label="요청 취소">취소</button>` : ''}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>` : '<p class="sales-state">등록된 충전 요청이 없습니다.</p>'}
        </div>
      </section>`;

    const ledgerMarkup = canSeeLedger ? `
      <section class="module-section">
        <div class="module-section-head">
          <span><strong>재무 장부 직접 기입</strong><small>자동 승인으로 처리할 수 없는 차감·환불·예외 건에 사용합니다</small></span>
          <span class="module-chip live">${esc(CREDIT_KINDS[form.kind])}</span>
        </div>
        <div class="module-section-body">
          <div class="intake-kind">
            ${Object.entries(CREDIT_KINDS).map(([key, label]) => `<button class="intake-kind-btn ${form.kind === key ? 'active' : ''}" type="button" data-credit-kind="${esc(key)}">${esc(label)}</button>`).join('')}
          </div>
          <div class="intake-form">
            <label class="intake-field"><span>일자</span>
              <input type="date" data-credit="date" value="${esc(form.date || localDateKey(new Date()))}"></label>
            <label class="intake-field"><span>업체명</span>
              <input type="text" data-credit="client" value="${esc(form.client)}" placeholder="업체명"></label>
            <label class="intake-field"><span>상품</span>
              <select data-credit="product">${[''].concat(majors).map(value => option(value, value || '선택', form.product)).join('')}</select></label>
            <label class="intake-field"><span>공급처</span>
              <select data-credit="vendor">${[''].concat(SUPPLIERS).map(value => option(value, value || '선택', form.vendor)).join('')}</select></label>
            <label class="intake-field"><span>입금액</span>
              <input type="number" min="0" data-credit="paid" value="${esc(form.paid)}" placeholder="통장에 들어온 돈"></label>
            <label class="intake-field"><span>충전 포인트</span>
              <input type="number" min="0" data-credit="point" value="${esc(form.point)}" placeholder="실제 충전한 포인트"></label>
          </div>
          <label class="intake-field wide"><span>특이사항</span>
            <input type="text" data-credit="memo" value="${esc(form.memo)}" placeholder="예: 잔여 8,200P → 500,000 충전"></label>
          <div class="intake-foot">
            <p class="sales-basis">입금액과 충전 포인트가 다를 수 있어 따로 받습니다. 자동 승인 건은 위 요청에서 장부로 들어옵니다.</p>
            <button class="module-action primary" type="button" data-credit-add>${esc(CREDIT_KINDS[form.kind])} 기입</button>
          </div>
        </div>
      </section>

      <section class="module-section">
        <div class="module-section-head">
          <span><strong>조회 기간 충전금 증감</strong><small>${esc(financePeriodLabel())} · 현재 전체 잔여 ${esc(currentPoint.toLocaleString('ko-KR'))}P</small></span>
          <span class="module-chip live">입금 ${esc(totalPaid.toLocaleString('ko-KR'))}원 · 포인트 ${esc(totalPoint.toLocaleString('ko-KR'))}P</span>
        </div>
        <div class="module-section-body">
          ${clients.length ? `<div class="sales-table-scroll">
            <table class="sales-table">
              <thead><tr><th scope="col">업체명</th><th scope="col">건수</th><th scope="col">입금액</th><th scope="col">충전 포인트</th><th scope="col">차이</th></tr></thead>
              <tbody>${clients.map(item => `<tr>
                <th scope="row">${esc(item.client)}</th>
                <td>${esc(item.rows.length.toLocaleString('ko-KR'))}건</td>
                <td>${esc(item.paid.toLocaleString('ko-KR'))}</td>
                <td class="sales-cell-total">${esc(item.point.toLocaleString('ko-KR'))}</td>
                <td class="${item.point - item.paid ? '' : 'ledger-memo-empty'}">${esc((item.point - item.paid).toLocaleString('ko-KR'))}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>` : '<p class="sales-state">선택한 기간에 기입된 충전금이 없습니다.</p>'}
        </div>
      </section>

      ${ledgerRows.length ? `<section class="module-section">
        <div class="module-section-head"><span><strong>충전금 장부</strong><small>${esc(financePeriodLabel())} · ${esc(String(ledgerRows.length))}건</small></span></div>
        <div class="module-section-body">
          <div class="sales-table-scroll">
            <table class="sales-table ledger-table">
              <thead><tr><th scope="col">일자</th><th scope="col">업체명</th><th scope="col">상품</th><th scope="col">공급처</th><th scope="col">내용</th><th scope="col">입금액</th><th scope="col">포인트</th><th scope="col">특이사항</th><th scope="col" aria-label="삭제"></th></tr></thead>
              <tbody>${[...ledgerRows].sort((a, b) => String(b.date).localeCompare(String(a.date))).map(row => `<tr>
                <td>${esc(row.date.slice(5).replace('-', '/'))}</td>
                <th scope="row">${esc(row.client || '업체 미입력')}</th>
                <td>${esc(row.product || '—')}</td>
                <td>${esc(row.vendor || '—')}</td>
                <td><span class="kind-badge ${row.kind === 'charge' ? 'added' : 'refund'}">${esc(CREDIT_KINDS[row.kind])}</span></td>
                <td>${esc(((Number(row.paid) || 0) * creditSign(row)).toLocaleString('ko-KR'))}</td>
                <td>${esc(((Number(row.point) || 0) * creditSign(row)).toLocaleString('ko-KR'))}</td>
                <td class="ledger-memo">${row.memo ? esc(row.memo) : '<span class="ledger-memo-empty">—</span>'}</td>
                <td><button class="ledger-remove" type="button" data-credit-remove="${esc(row.id)}" aria-label="삭제">✕</button></td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
        </div>
      </section>` : ''}` : '';

    moduleView.innerHTML = `
      ${moduleStatusbar('충전금', '영업 요청부터 통장 입금확인과 충전 승인까지 한 흐름으로 관리합니다.', pendingCount ? `조회 기간 입금 대기 ${pendingCount}건` : (allPendingCount ? `전체 입금 대기 ${allPendingCount}건` : (canSeeLedger ? `현재 잔여 ${currentPoint.toLocaleString('ko-KR')}P` : '요청 가능')))}
      ${renderFinancePeriodFilter('credit', '요청일·장부일 기준 · 현재 잔여는 전체 누적')}
      ${requestMarkup}
      ${ledgerMarkup}
      <div class="module-security"><span>▣</span><span><strong>금액과 입금자명이 정확히 같은 한 건만 자동 승인합니다</strong><br>리뷰·리워드 통장의 입금액, 실제 입금자명, 대기 요청이 모두 정확히 일치하고 후보가 하나일 때만 승인합니다. 부분입금·묶음입금·이름이 다른 건·중복 후보는 자동 처리하지 않습니다.</span></div>`;
  }

  // 세금·환불·비용 요청. 기존 공개 Google 시트의 필드 구조를 서버 장부로
  // 옮기되 환불계좌 원문은 서버에서 암호화하고 화면에는 권한에 따라 마스킹한다.
  const FINANCE_REQUEST_KIND_LABEL = {
    TAX_ADVANCE: '세금계산서 선발행',
    TAX_CORRECTION: '세금계산서 정정',
    REFUND_CLIENT: '거래처환불',
    REFUND_MISTAKEN: '오입금환불',
    EXPENSE_AD: '광고비',
    EXPENSE_SUPPLIES: '비품·복리후생'
  };
  const FINANCE_REQUEST_STATUS = {
    PENDING: ['접수 대기', 'review'],
    REVIEWING: ['검토 중', 'review'],
    APPROVED: ['승인', 'done'],
    PROCESSING: ['처리 중', 'review'],
    COMPLETED: ['처리 완료', 'done'],
    REJECTED: ['반려', 'danger'],
    CANCELLED: ['취소', 'muted']
  };
  const FINANCE_INVOICE_STATUS = {
    NOT_REQUESTED: '요청 없음',
    REQUESTED: '계산서 요청',
    PROCESSING: '계산서 처리 중',
    ISSUED: '계산서 발행 완료',
    CORRECTION_REQUESTED: '계산서 정정 요청',
    CORRECTED: '계산서 정정 완료',
    FAILED: '계산서 처리 실패',
    CANCELLED: '계산서 요청 취소'
  };
  const PUBLIC_REFUND_ACCOUNTS = [
    ['ibk-hq-sales', '매출통장'],
    ['ibk-review-space', '리뷰스페이스통장'],
    ['ibk-reward-space', '리워드스페이스통장']
  ];

  function financeValue(row, camel, snake = '') {
    return row?.[camel] ?? (snake ? row?.[snake] : undefined) ?? '';
  }

  function financeSafeUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      return url.protocol === 'https:' ? url.toString().slice(0, 2000) : '';
    } catch (_) {
      return '';
    }
  }

  function financeRequestDefault(view) {
    const config = FINANCE_REQUEST_CONFIG[view] || {};
    return {
      view,
      idempotencyKey: crypto.randomUUID?.() || `finance-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      requestDate: localDateKey(new Date()),
      client: '', detail: '', amount: '', businessRegistrationUrl: '', email: '',
      payeeBank: '', payeeAccount: '', payeeName: '', memo: '', evidenceUrl: '',
      sourceAccountId: config.refund ? 'ibk-hq-sales' : '', invoiceRequested: false
    };
  }

  function currentFinanceRequestForm(view) {
    if (financeRequestForm.view !== view) financeRequestForm = financeRequestDefault(view);
    return financeRequestForm;
  }

  function financeRequestQuery(view, page = 1) {
    const params = new URLSearchParams({
      scope: canReviewFinanceRequests() ? 'all' : 'mine',
      page: String(Math.max(1, Number(page) || 1)),
      limit: '50'
    });
    const config = FINANCE_REQUEST_CONFIG[view];
    if (config?.kind) params.set('kind', config.kind);
    if (view === 'refund-history' || view === 'refund-invoice') {
      params.set('kind', 'REFUND_CLIENT,REFUND_MISTAKEN');
    }
    if (view === 'refund-invoice') {
      params.set('invoiceRequested', 'true');
      params.set('excludeStatus', 'REJECTED,CANCELLED');
    }
    const { from, to } = financePeriodBounds();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return params;
  }

  async function loadFinanceRequests({ quiet = false, view = activeView, page = 1 } = {}) {
    if (!canUseFinanceRequests()) {
      financeRequestState = {
        status: 'idle', requests: [], scope: 'mine', error: '', view: '', queryKey: '',
        pagination: { page: 1, limit: 50, total: 0, totalPages: 0 }
      };
      return;
    }
    if (!FINANCE_REQUEST_VIEWS.includes(view)) return;
    const generation = ++financeRequestLoadGeneration;
    const scope = canReviewFinanceRequests() ? 'all' : 'mine';
    const params = financeRequestQuery(view, page);
    const queryKey = params.toString();
    if (!quiet) financeRequestState = {
      ...financeRequestState,
      status: 'loading', scope, error: '', view, queryKey,
      pagination: { ...financeRequestState.pagination, page: Math.max(1, Number(page) || 1) }
    };
    try {
      const payload = await readOnlyApi(`/peakos/finance-requests?${queryKey}`);
      if (generation !== financeRequestLoadGeneration) return;
      const rawPagination = payload?.pagination || {};
      const normalizedPage = Number(rawPagination.page || page || 1);
      const normalizedLimit = Number(rawPagination.limit || 50);
      const total = Number(rawPagination.total ?? (Array.isArray(payload?.requests) ? payload.requests.length : 0));
      const totalPages = Number(rawPagination.totalPages ?? rawPagination.total_pages
        ?? (total ? Math.ceil(total / Math.max(1, normalizedLimit)) : 0));
      financeRequestState = {
        status: 'ready',
        requests: Array.isArray(payload?.requests) ? payload.requests : (Array.isArray(payload) ? payload : []),
        scope: payload?.scope || scope,
        error: '', view, queryKey,
        pagination: {
          page: Math.max(1, normalizedPage || 1),
          limit: Math.max(1, normalizedLimit || 50),
          total: Math.max(0, total || 0),
          totalPages: Math.max(0, totalPages || 0)
        }
      };
    } catch (error) {
      if (generation !== financeRequestLoadGeneration) return;
      financeRequestState = {
        status: 'error', requests: [], scope,
        error: error.message || '요청 장부를 불러오지 못했습니다.', view, queryKey,
        pagination: { page: Math.max(1, Number(page) || 1), limit: 50, total: 0, totalPages: 0 }
      };
    }
  }

  function financeRequestRows(view) {
    const rows = financeRequestState.requests.filter(row => inFinancePeriod(
      String(financeValue(row, 'requestDate', 'request_date')).slice(0, 10)
    ));
    if (view === 'refund-history') {
      return rows.filter(row => ['REFUND_CLIENT', 'REFUND_MISTAKEN'].includes(financeValue(row, 'kind')));
    }
    if (view === 'refund-invoice') {
      return rows.filter(row => ['REFUND_CLIENT', 'REFUND_MISTAKEN'].includes(financeValue(row, 'kind'))
        && Boolean(financeValue(row, 'invoiceRequested', 'invoice_requested'))
        && !['REJECTED', 'CANCELLED'].includes(String(financeValue(row, 'status')).toUpperCase()));
    }
    const config = FINANCE_REQUEST_CONFIG[view];
    return config ? rows.filter(row => financeValue(row, 'kind') === config.kind) : [];
  }

  function financeAccountLabel(row) {
    const full = String(financeValue(row, 'payeeAccount', 'payee_account') || '').trim();
    const masked = String(financeValue(row, 'payeeAccountMasked', 'payee_account_masked') || '').trim();
    if (canReviewFinanceRequests() && full) return full;
    if (masked) return masked;
    if (!full) return '미입력';
    const digits = full.replace(/\D/g, '');
    return digits.length > 4 ? `****-${digits.slice(-4)}` : '****';
  }

  function financeEvidenceLink(value, label) {
    const safe = financeSafeUrl(value);
    return safe ? `<a class="finance-evidence-link" href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : '';
  }

  function financeStatusActions(statusKey, id) {
    if (!canReviewFinanceRequests()) return '';
    const actionMap = {
      PENDING: [
        ['REVIEWING', '검토 시작', ''],
        ['PROCESSING', '처리 시작', 'primary'],
        ['REJECTED', '반려', 'danger']
      ],
      REVIEWING: [
        ['APPROVED', '승인', ''],
        ['PROCESSING', '처리 시작', 'primary'],
        ['REJECTED', '반려', 'danger']
      ],
      APPROVED: [
        ['PROCESSING', '처리 시작', ''],
        ['COMPLETED', '처리 완료', 'primary'],
        ['REJECTED', '반려', 'danger']
      ],
      PROCESSING: [
        ['APPROVED', '승인으로 전환', ''],
        ['COMPLETED', '처리 완료', 'primary'],
        ['REJECTED', '반려', 'danger']
      ]
    };
    return (actionMap[statusKey] || []).map(([next, label, tone]) =>
      `<button class="module-action ${tone}" type="button" data-finance-status="${esc(next)}" data-finance-id="${esc(id)}">${esc(label)}</button>`
    ).join('');
  }

  function financeInvoiceAction(invoiceStatus, requestStatus, id) {
    if (!canReviewFinanceRequests() || ['REJECTED', 'CANCELLED'].includes(requestStatus)) return '';
    if (['REQUESTED', 'PROCESSING'].includes(invoiceStatus)) {
      return `<button class="module-action" type="button" data-finance-invoice-status="ISSUED" data-finance-id="${esc(id)}">계산서 발행완료</button>`;
    }
    if (invoiceStatus === 'CORRECTION_REQUESTED') {
      return `<button class="module-action" type="button" data-finance-invoice-status="CORRECTED" data-finance-id="${esc(id)}">계산서 정정완료</button>`;
    }
    if (['FAILED', 'CANCELLED'].includes(invoiceStatus)) {
      return `<button class="module-action" type="button" data-finance-invoice-status="REQUESTED" data-finance-id="${esc(id)}">계산서 재요청</button>`;
    }
    return '';
  }

  function renderFinanceRequestCards(view, rows) {
    if (!rows.length) return '<p class="sales-state">조회 조건에 맞는 요청이 없습니다.</p>';
    return `<div class="finance-request-list" data-finance-request-list>
      ${rows.map(row => {
        const id = String(financeValue(row, 'id'));
        const kind = String(financeValue(row, 'kind'));
        const statusKey = String(financeValue(row, 'status') || 'PENDING').toUpperCase();
        const status = FINANCE_REQUEST_STATUS[statusKey] || [statusKey, 'muted'];
        const invoiceRequested = Boolean(financeValue(row, 'invoiceRequested', 'invoice_requested'));
        const invoiceStatus = String(financeValue(row, 'invoiceStatus', 'invoice_status') || (invoiceRequested ? 'REQUESTED' : 'NOT_REQUESTED')).toUpperCase();
        const amount = Number(financeValue(row, 'amountVat', 'amount_vat') || 0);
        const requester = String(financeValue(row, 'requesterName', 'requester_name') || '요청자');
        const isOwner = String(financeValue(row, 'requesterUid', 'requester_uid')) === String(userDoc?.uid || '');
        const canCancel = isOwner && statusKey === 'PENDING';
        const payeeMarkup = ['REFUND_CLIENT', 'REFUND_MISTAKEN', 'EXPENSE_AD'].includes(kind) ? `
          <div><dt>지급 정보</dt><dd>${esc([financeValue(row, 'payeeBank', 'payee_bank'), financeAccountLabel(row), financeValue(row, 'payeeName', 'payee_name')].filter(Boolean).join(' · '))}</dd></div>` : '';
        const evidence = [
          financeEvidenceLink(financeValue(row, 'evidenceUrl', 'evidence_url'), '요청 증빙'),
          financeEvidenceLink(financeValue(row, 'businessRegistrationUrl', 'business_registration_url'), '사업자등록증'),
          financeEvidenceLink(financeValue(row, 'invoiceEvidenceUrl', 'invoice_evidence_url'), '계산서 증빙')
        ].filter(Boolean).join(' · ');
        return `<article class="finance-request-card" data-finance-request-row="${esc(id)}">
          <div class="finance-request-head">
            <span><strong>${esc(financeValue(row, 'clientName', 'client_name') || '업체 미입력')}</strong><small>${esc(financeValue(row, 'requestDate', 'request_date'))} · ${esc(requester)} · ${esc(FINANCE_REQUEST_KIND_LABEL[kind] || kind)}</small></span>
            <span class="bank-status ${esc(status[1])}">${esc(status[0])}</span>
          </div>
          <div class="finance-request-amount">${amount.toLocaleString('ko-KR')}원 <small>VAT 포함</small></div>
          <dl class="finance-request-meta">
            <div><dt>상세내용</dt><dd>${esc(financeValue(row, 'detail') || '-')}</dd></div>
            <div><dt>사유</dt><dd>${esc(financeValue(row, 'reason') || '-')}</dd></div>
            ${financeValue(row, 'email') ? `<div><dt>이메일</dt><dd>${esc(financeValue(row, 'email'))}</dd></div>` : ''}
            ${payeeMarkup}
            ${invoiceRequested ? `<div><dt>계산서 요청</dt><dd><span class="vendor-chip ${['ISSUED', 'CORRECTED'].includes(invoiceStatus) ? 'done' : ''}">${esc(FINANCE_INVOICE_STATUS[invoiceStatus] || invoiceStatus)}</span></dd></div>` : ''}
            ${evidence ? `<div><dt>첨부·증빙</dt><dd>${evidence}</dd></div>` : ''}
            ${financeValue(row, 'processedAt', 'processed_at') ? `<div><dt>처리완료</dt><dd>${esc(formatDate(financeValue(row, 'processedAt', 'processed_at'), { dateStyle: 'medium', timeStyle: 'short' }))}</dd></div>` : ''}
          </dl>
          <div class="finance-request-actions">
            ${financeStatusActions(statusKey, id)}
            ${invoiceRequested ? financeInvoiceAction(invoiceStatus, statusKey, id) : ''}
            ${canCancel ? `<button class="module-action" type="button" data-finance-cancel="${esc(id)}">요청 취소</button>` : ''}
          </div>
        </article>`;
      }).join('')}
    </div>`;
  }

  function renderFinanceRequestForm(view) {
    const config = FINANCE_REQUEST_CONFIG[view];
    if (!config) return '';
    const form = currentFinanceRequestForm(view);
    return `<section class="module-section finance-request-form" data-finance-request-form>
      <div class="module-section-head"><span><strong>${esc(config.title)} 등록</strong><small>${esc(config.description)}</small></span><span class="module-chip live">서버 저장</span></div>
      <div class="module-section-body">
        <div class="finance-request-fields">
          <label class="intake-field"><span>요청일</span><input type="date" data-finance-request="requestDate" value="${esc(form.requestDate)}"></label>
          <label class="intake-field"><span>업체명·구매처</span><input type="text" data-finance-request="client" value="${esc(form.client)}" placeholder="업체명 또는 구매처"></label>
          <label class="intake-field finance-field-wide"><span>상세내용</span><input type="text" data-finance-request="detail" value="${esc(form.detail)}" placeholder="품목·변경내용·입금 시각 등을 정확히 입력"></label>
          <label class="intake-field"><span>금액 (VAT 포함)</span><input type="number" min="1" step="1" data-finance-request="amount" value="${esc(form.amount)}" placeholder="0"></label>
          ${config.requiresBusiness ? `<label class="intake-field finance-field-wide"><span>사업자등록증 비공개 링크</span><input type="url" data-finance-request="businessRegistrationUrl" value="${esc(form.businessRegistrationUrl)}" placeholder="권한이 제한된 Drive 링크"></label>` : ''}
          ${config.requiresEmail ? `<label class="intake-field"><span>계산서 이메일</span><input type="email" data-finance-request="email" value="${esc(form.email)}" placeholder="tax@example.com"></label>` : ''}
          ${config.requiresPayee ? `<label class="intake-field"><span>은행</span><input type="text" data-finance-request="payeeBank" value="${esc(form.payeeBank)}" placeholder="은행명"></label>
          <label class="intake-field finance-field-wide"><span>환불·지급 계좌번호</span><input type="text" inputmode="numeric" autocomplete="off" data-finance-request="payeeAccount" value="${esc(form.payeeAccount)}" placeholder="계좌번호"></label>
          <label class="intake-field"><span>예금주명</span><input type="text" data-finance-request="payeeName" value="${esc(form.payeeName)}" placeholder="예금주"></label>` : ''}
          ${config.refund ? `<label class="intake-field"><span>입금받았던 통장</span><select data-finance-request="sourceAccountId">${PUBLIC_REFUND_ACCOUNTS.map(([id, label]) => `<option value="${esc(id)}" ${form.sourceAccountId === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
          <label class="finance-request-check"><input type="checkbox" data-finance-request="invoiceRequested" ${form.invoiceRequested ? 'checked' : ''}><span><strong>환불 계산서 요청</strong><small>마이너스 발행·정정이 필요하면 체크</small></span></label>` : ''}
          <label class="intake-field finance-field-wide"><span>증빙 이미지·문서 비공개 링크</span><input type="url" data-finance-request="evidenceUrl" value="${esc(form.evidenceUrl)}" placeholder="권한이 제한된 Drive 링크"></label>
          <label class="intake-field finance-field-full"><span>사유</span><textarea data-finance-request="memo" rows="3" placeholder="처리자가 확인할 정확한 사유">${esc(form.memo)}</textarea></label>
        </div>
        <div class="intake-foot">
          <p class="sales-basis">${config.refund ? '거래처 환불은 오후 5시 30분 일괄 처리되며 이후 요청은 다음 영업일로 넘어갑니다.' : '처리 담당자가 상태와 완료일을 기록하며 요청자는 임의로 완료 처리할 수 없습니다.'}</p>
          <button class="module-action primary" type="button" data-finance-request-submit>${esc(config.action)}</button>
        </div>
      </div>
    </section>`;
  }

  function renderFinanceRequestModule(view) {
    if (!canUseFinanceRequests()) {
      moduleView.innerHTML = `${moduleStatusbar(PLANNED_MODULES[view], '실제 로그인 계정에서만 사용할 수 있습니다.', '접근 제한')}`;
      return;
    }
    const currentPage = financeRequestState.view === view ? Number(financeRequestState.pagination?.page || 1) : 1;
    const expectedQueryKey = financeRequestQuery(view, currentPage).toString();
    const staleQuery = financeRequestState.view !== view || financeRequestState.queryKey !== expectedQueryKey;
    if (staleQuery) {
      financeRequestLoadGeneration += 1;
      financeRequestState = {
        ...financeRequestState, status: 'idle', requests: [], error: '', view, queryKey: expectedQueryKey,
        pagination: { page: 1, limit: 50, total: 0, totalPages: 0 }
      };
    }
    if (financeRequestState.status === 'idle' || financeRequestState.status === 'loading') {
      moduleView.innerHTML = `<div data-finance-request-module="${esc(view)}">${moduleStatusbar(PLANNED_MODULES[view], '금융 요청 장부를 안전하게 불러옵니다.', '불러오는 중')}<section class="module-section"><div class="module-section-body"><p class="sales-state">요청 내역을 불러오고 있습니다.</p></div></section></div>`;
      if (financeRequestState.status === 'idle') Promise.resolve().then(() => loadFinanceRequests({ view, page: 1 }).then(() => activeView === view && renderPlannedModule(view)));
      return;
    }
    if (financeRequestState.status === 'error') {
      moduleView.innerHTML = `<div data-finance-request-module="${esc(view)}">${moduleStatusbar(PLANNED_MODULES[view], '요청 장부를 불러오지 못했습니다.', '조회 실패')}<section class="module-section"><div class="module-section-body"><p class="sales-state">${esc(financeRequestState.error)}</p><button class="module-action" type="button" data-finance-request-refresh>다시 조회</button></div></section></div>`;
      return;
    }
    const rows = financeRequestRows(view);
    const pagination = financeRequestState.pagination || { page: 1, total: rows.length, totalPages: 1 };
    const isQueue = view === 'refund-history' || view === 'refund-invoice';
    const title = view === 'refund-invoice' ? '환불 계산서 요청 큐' : PLANNED_MODULES[view];
    const description = view === 'refund-history'
      ? '거래처환불과 오입금환불 요청·처리 상태를 한곳에서 확인합니다.'
      : view === 'refund-invoice'
        ? '환불 요청 중 계산서 정정·마이너스 발행이 필요한 건만 자동으로 모읍니다.'
        : FINANCE_REQUEST_CONFIG[view]?.description || '';
    moduleView.innerHTML = `<div class="finance-workflow" data-finance-request-module="${esc(view)}">
      ${moduleStatusbar(title, description, canReviewFinanceRequests() ? '전체 요청 · 처리 가능' : '내 요청')}
      ${renderFinancePeriodFilter(view, '요청일 기준')}
      ${isQueue ? '' : renderFinanceRequestForm(view)}
      <section class="module-section">
        <div class="module-section-head"><span><strong>${esc(isQueue ? title : '요청 내역')}</strong><small>${esc(financePeriodLabel())} · 전체 ${Number(pagination.total || 0).toLocaleString('ko-KR')}건</small></span><button class="module-action" type="button" data-finance-request-refresh>새로고침</button></div>
        <div class="module-section-body">${renderFinanceRequestCards(view, rows)}
          ${Number(pagination.totalPages || 0) > 1 ? `<div class="bank-pagination" aria-label="금융 요청 페이지">
            <button class="module-action" type="button" data-finance-request-page="${Math.max(1, Number(pagination.page) - 1)}" ${Number(pagination.page) <= 1 ? 'disabled' : ''}>이전</button>
            <span>${Number(pagination.page).toLocaleString('ko-KR')} / ${Number(pagination.totalPages).toLocaleString('ko-KR')} 페이지</span>
            <button class="module-action" type="button" data-finance-request-page="${Math.min(Number(pagination.totalPages), Number(pagination.page) + 1)}" ${Number(pagination.page) >= Number(pagination.totalPages) ? 'disabled' : ''}>다음</button>
          </div>` : ''}
        </div>
      </section>
      <div class="module-security"><span>▣</span><span><strong>계좌번호는 암호화 저장하고 권한에 따라 마스킹합니다</strong><br>일반 직원은 자기 요청만, 지정 재무 담당자는 전체 요청과 처리 상태만 볼 수 있습니다. 증빙 링크도 반드시 접근 권한이 제한된 문서를 사용해 주세요.</span></div>
    </div>`;
  }

  // 세금계산서 매출 — 개인 접수에서 선택 기간의 공급가액과 세액을 뽑는다.
  function invoiceSourceRows() {
    const source = canReviewFinanceRequests() ? reviewedIntakeRows() : personalRows();
    return source
      .filter(row => kindOf(row) !== 'reserve')
      .filter(row => inFinancePeriod(row.date));
  }

  function invoiceGroups(sourceRows = invoiceSourceRows()) {
    const map = new Map();
    sourceRows.forEach(row => {
        const key = row.client || '업체 미입력';
        if (!map.has(key)) map.set(key, { client: key, supply: 0, count: 0, paid: 0 });
        const item = map.get(key);
        const sign = signOf(row);
        const sales = (Number(row.sell) || 0) * (Number(row.qty) || 0) * sign;
        item.supply += sales;
        item.paid += kindOf(row) === 'use' ? sales : (Number(row.paidAmount) || 0) * sign;
        item.count += 1;
      });
    return [...map.values()]
      .map(item => ({ ...item, tax: Math.round(item.supply * 0.1) }))
      .sort((a, b) => b.supply - a.supply);
  }

  function renderInvoiceModule() {
    const groups = invoiceGroups();
    const total = groups.reduce((sum, item) => ({ supply: sum.supply + item.supply, tax: sum.tax + item.tax }), { supply: 0, tax: 0 });

    moduleView.innerHTML = `
      ${moduleStatusbar('세금계산서 매출', '접수 매출을 업체별 공급가액·예상 세액으로 정리합니다.', `${groups.length}개 업체`)}

      <section class="module-section">
        <div class="module-section-head">
          <span><strong>발행 대상</strong><small>${esc(financePeriodLabel())} · ${esc(String(groups.length))}개 업체</small></span>
          <span class="module-chip live">공급가액 ${esc(total.supply.toLocaleString('ko-KR'))} · 세액 ${esc(total.tax.toLocaleString('ko-KR'))}</span>
        </div>
        <div class="module-section-body">
          ${renderFinancePeriodFilter('invoice', '접수일 기준 · 세액은 공급가액의 10% 예상치')}
          ${groups.length ? `<div class="sales-table-scroll">
            <table class="sales-table">
              <thead><tr><th scope="col">업체명</th><th scope="col">건수</th><th scope="col">공급가액</th><th scope="col">세액</th><th scope="col">합계</th><th scope="col">입금</th><th scope="col" aria-label="발행"></th></tr></thead>
              <tbody>
                ${groups.map(item => `<tr>
                  <th scope="row">${esc(item.client)}</th>
                  <td>${esc(item.count.toLocaleString('ko-KR'))}건</td>
                  <td>${esc(item.supply.toLocaleString('ko-KR'))}</td>
                  <td>${esc(item.tax.toLocaleString('ko-KR'))}</td>
                  <td class="sales-cell-total">${esc((item.supply + item.tax).toLocaleString('ko-KR'))}</td>
                  <td>${item.paid >= item.supply ? '<span class="vendor-chip done">입금</span>' : `<span class="vendor-chip">미수 ${esc((item.supply - item.paid).toLocaleString('ko-KR'))}</span>`}</td>
                  <td><button class="module-action" type="button" data-invoice-estimate="${esc(item.client)}">정산서 보기</button></td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>` : '<p class="sales-state">발행할 건이 아직 없습니다.</p>'}
        </div>
      </section>

      <div class="module-security"><span>⌘</span><span><strong>운영 플랫폼 2개의 세금계산서 API를 연결할 수 있습니다</strong><br>현재는 내부 매출 기준으로 계산하며, 플랫폼 이름·API 문서·인증방식이 확인되면 서버 어댑터에서 발행·정정·상태조회를 연결하고 외부 문서번호로 중복 발행을 막습니다.</span></div>`;
  }

  // 결산 — 지금 들고 있는 숫자로 만들 수 있는 월별 요약.
  function closingSourceRows() {
    return personalRows()
      .filter(row => kindOf(row) !== 'reserve')
      .filter(row => inFinancePeriod(row.date));
  }

  function closingMonths(sourceRows = closingSourceRows()) {
    const map = new Map();
    sourceRows.forEach(row => {
      const key = String(row.date).slice(0, 7);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    });
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }

  function renderClosingModule() {
    if (!canSeeFinalSettlement()) {
      moduleView.innerHTML = `
        ${moduleStatusbar('결산', '지정된 인원만 볼 수 있습니다.', '접근 제한')}
        <section class="module-section">
          <div class="module-section-head"><span><strong>열람 권한이 없습니다</strong><small>결산은 최종정산서 열람자만 봅니다</small></span><span class="module-chip restricted">지정 인원 전용</span></div>
          <div class="module-section-body"><p class="sales-state">대표 · 손명아 실장 · 김대호 부장 · 박종원 부장 · 전현우 팀장만 볼 수 있습니다.</p></div>
        </section>`;
      return;
    }

    const sourceRows = closingSourceRows();
    const months = closingMonths(sourceRows);
    const all = finalTotals(sourceRows);

    moduleView.innerHTML = `
      ${moduleStatusbar('결산 (접수 기준)', '현재 로그인 계정의 접수를 선택 기간으로 합산합니다.', '현재 상태 요약')}
      ${renderFinancePeriodFilter('closing', '내 접수일 기준 · 과거 월말 잔액 아님')}

      <section class="module-section">
        <div class="module-section-head">
          <span><strong>접수 기준 월별 요약</strong><small>${esc(financePeriodLabel())} · ${esc(String(months.length))}개월</small></span>
          <span class="module-chip live">회사이익 ${esc(all.companyProfit.toLocaleString('ko-KR'))}원</span>
        </div>
        <div class="module-section-body">
          ${months.length ? `<div class="sales-table-scroll">
            <table class="sales-table">
              <thead><tr><th scope="col">귀속 월</th><th scope="col">건수</th><th scope="col">판매가액</th><th scope="col">회사 공급가</th><th scope="col">영업자이익</th><th scope="col">회사이익</th><th scope="col">미수금</th><th scope="col">공급사 미정산</th></tr></thead>
              <tbody>
                ${months.map(([month, rows]) => {
                  const sum = finalTotals(rows);
                  const paid = intakeTotals(rows).paid;
                  return `<tr>
                    <th scope="row">${esc(month.replace('-', '년 '))}월</th>
                    <td>${esc(rows.length.toLocaleString('ko-KR'))}건</td>
                    <td>${esc(sum.sales.toLocaleString('ko-KR'))}</td>
                    <td>${esc(sum.vendorDue.toLocaleString('ko-KR'))}</td>
                    <td>${esc(sum.salesProfit.toLocaleString('ko-KR'))}</td>
                    <td class="sales-cell-total">${esc(sum.companyProfit.toLocaleString('ko-KR'))}</td>
                    <td class="${sum.sales - paid > 0 ? 'monthly-minus' : ''}">${esc(Math.max(0, sum.sales - paid).toLocaleString('ko-KR'))}</td>
                    <td class="${sum.vendorUnpaid ? 'monthly-minus' : ''}">${esc(sum.vendorUnpaid.toLocaleString('ko-KR'))}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
          <div class="final-total">
            <span>전체</span>
            <span>판매가액 <strong>${esc(all.sales.toLocaleString('ko-KR'))}</strong></span>
            <span>회사 공급가 <strong>${esc(all.vendorDue.toLocaleString('ko-KR'))}</strong></span>
            <span>회사이익 <strong class="profit">${esc(all.companyProfit.toLocaleString('ko-KR'))}</strong></span>
            <span>공급사 미정산 <strong class="unpaid">${esc(all.vendorUnpaid.toLocaleString('ko-KR'))}</strong></span>
          </div>` : '<p class="sales-state">결산할 접수가 아직 없습니다.</p>'}
        </div>
      </section>

      <div class="module-security"><span>▣</span><span><strong>회사 전체 결산이나 과거 월말 잔액이 아닙니다</strong><br>현재 로그인 계정의 접수와 현재 입금·공급사 정산 상태를 묶은 요약입니다. 고정비·인건비·세금·통장 지출은 아직 포함하지 않습니다.</span></div>`;
  }

  // 명함 — 제공받은 앞·뒷면 디자인을 한 장의 세로형 고해상도 이미지로 그린다.
  const NAMECARD_WIDTH = 900;
  const NAMECARD_SIDE_HEIGHT = 500;
  const NAMECARD_HEIGHT = NAMECARD_SIDE_HEIGHT * 2;
  const NAMECARD_SCALE = 2;
  const NAMECARD_BLUE = '#3a94c9';
  const NAMECARD_ADDRESSES = [
    ['서울 본사', '경기 남양주시 순화궁로 249 N동 1707호'],
    ['전주 지사', '전북 전주시 완산구 홍산로 260, 엠스퀘어 307호'],
    ['대구 지사', '대구 중구 태평로 28길 14']
  ];
  let namecardForm = { name: '', englishName: '', rank: '', team: '', phone: '', email: '' };
  let namecardInitialized = false;

  function namecardFont(size, weight = '400', family = 'ko') {
    const fonts = family === 'en'
      ? '"Helvetica Neue", Arial, sans-serif'
      : 'Pretendard, "Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    return `${weight} ${size}px ${fonts}`;
  }

  function fitNamecardText(g, value, maxWidth, startSize, minSize, weight = '400', family = 'ko') {
    const text = String(value || '');
    let size = startSize;
    while (size > minSize) {
      g.font = namecardFont(size, weight, family);
      if (g.measureText(text).width <= maxWidth) return text;
      size -= 1;
    }

    g.font = namecardFont(minSize, weight, family);
    if (g.measureText(text).width <= maxWidth) return text;

    const chars = [...text];
    const ellipsis = '…';
    let low = 0;
    let high = chars.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (g.measureText(`${chars.slice(0, middle).join('')}${ellipsis}`).width <= maxWidth) low = middle;
      else high = middle - 1;
    }
    return low ? `${chars.slice(0, low).join('').trimEnd()}${ellipsis}` : '';
  }

  function drawNamecardTrackedText(g, text, x, y, tracking) {
    let offset = x;
    [...String(text)].forEach(char => {
      g.fillText(char, offset, y);
      offset += g.measureText(char).width + tracking;
    });
    return offset - x;
  }

  // 피크의 원형 화살표 심볼을 Canvas path로 그려 확대해도 가장자리가 깨지지 않게 한다.
  function drawNamecardMark(g, x, y, size, color) {
    const cx = x + size * .43;
    const cy = y + size * .60;
    const radius = size * .285;
    const stroke = size * .105;
    const arrowX = x + size * .64;

    g.save();
    g.strokeStyle = color;
    g.lineWidth = stroke;
    g.lineCap = 'butt';
    g.beginPath();
    g.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 5, true);
    g.stroke();

    g.fillStyle = color;
    g.fillRect(arrowX - stroke / 2, y + size * .28, stroke, size * .39);
    g.beginPath();
    g.moveTo(arrowX, y + size * .02);
    g.lineTo(arrowX + size * .205, y + size * .33);
    g.lineTo(arrowX + stroke / 2, y + size * .33);
    g.lineTo(arrowX - stroke / 2, y + size * .33);
    g.lineTo(arrowX - size * .205, y + size * .33);
    g.closePath();
    g.fill();

    g.beginPath();
    g.arc(x + size * .84, y + size * .79, size * .045, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  // 워드마크의 a 자리에 원형 화살표를 넣어 예시 명함의 로고 인상을 유지한다.
  function drawNamecardWordmark(g, x, baseline, size, color, accent = color, weight = '500') {
    g.save();
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.font = namecardFont(size, weight, 'en');
    g.fillStyle = color;
    g.fillText('Pe', x, baseline);
    const peWidth = g.measureText('Pe').width;
    const markSize = size * .78;
    const markX = x + peWidth - size * .02;
    drawNamecardMark(g, markX, baseline - size * .82, markSize, accent);
    const kX = markX + markSize * .72;
    g.fillStyle = color;
    g.fillText('k', kX, baseline);
    const width = kX + g.measureText('k').width - x;
    g.restore();
    return width;
  }

  function setupNamecardCanvas(canvas) {
    canvas.width = NAMECARD_WIDTH * NAMECARD_SCALE;
    canvas.height = NAMECARD_HEIGHT * NAMECARD_SCALE;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.style.minWidth = '0';
    const g = canvas.getContext('2d');
    g.setTransform(NAMECARD_SCALE, 0, 0, NAMECARD_SCALE, 0, 0);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, NAMECARD_WIDTH, NAMECARD_HEIGHT);
    return g;
  }

  function drawNamecardBrandPanel(g) {
    g.fillStyle = NAMECARD_BLUE;
    g.fillRect(0, 0, NAMECARD_WIDTH, NAMECARD_SIDE_HEIGHT);
    drawNamecardWordmark(g, 42, 94, 72, '#ffffff', '#ffffff', '400');
    drawNamecardMark(g, 445, 8, 430, '#ffffff');

    g.fillStyle = '#ffffff';
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.font = namecardFont(24, '700', 'en');
    drawNamecardTrackedText(g, 'PEAK MARKETING', 45, 421, 8);
    g.font = namecardFont(18, '500');
    g.fillText('(주) 피크마케팅 | 종합온라인광고대행사', 45, 456);
  }

  function drawNamecardAddress(g, label, address, y) {
    const maxWidth = 515;
    let size = 18;
    while (size > 13) {
      g.font = namecardFont(size, '800');
      const labelWidth = g.measureText(label).width;
      g.font = namecardFont(size, '400');
      const addressWidth = g.measureText(` | ${address}`).width;
      if (labelWidth + addressWidth <= maxWidth) break;
      size -= 1;
    }

    g.fillStyle = '#111111';
    g.font = namecardFont(size, '800');
    g.fillText(label, 350, y);
    const labelWidth = g.measureText(label).width;
    const addressText = fitNamecardText(g, ` | ${address}`, maxWidth - labelWidth, size, 13);
    g.fillStyle = '#2f2f32';
    g.fillText(addressText, 350 + labelWidth, y);
  }

  function drawNamecardContact(g, label, value, y) {
    g.fillStyle = '#050505';
    g.font = namecardFont(25, '700', 'en');
    g.fillText(`${label}.`, 572, y);
    const text = String(value || '').trim() || (label === 'T' ? '010-0000-0000' : 'name@peak.kr');
    const fittedText = fitNamecardText(g, text, 260, 25, 16, '300', 'en');
    g.fillStyle = value ? '#111111' : '#a0a0a5';
    g.fillText(fittedText, 614, y);
  }

  function drawNamecardInfoPanel(g, data) {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, NAMECARD_WIDTH, NAMECARD_SIDE_HEIGHT);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';

    const name = String(data.name || '').trim() || '이름';
    const fittedName = fitNamecardText(g, name, 245, 48, 32, '700');
    g.fillStyle = '#050505';
    g.fillText(fittedName, 42, 91);
    const nameWidth = g.measureText(fittedName).width;

    const role = [data.team, data.rank].map(value => String(value || '').trim()).filter(Boolean).join(' ') || '소속 직급';
    const roleX = Math.min(310, 42 + nameWidth + 18);
    const fittedRole = fitNamecardText(g, role, 520 - roleX, 22, 14, '600');
    g.fillStyle = data.team || data.rank ? '#111111' : '#a0a0a5';
    g.fillText(fittedRole, roleX, 91);

    const englishName = String(data.englishName || '').trim() || 'English Name';
    const fittedEnglishName = fitNamecardText(g, englishName, 420, 24, 17, '300', 'en');
    g.fillStyle = data.englishName ? '#3c3c40' : '#a0a0a5';
    g.fillText(fittedEnglishName, 42, 130);

    drawNamecardContact(g, 'T', data.phone, 88);
    drawNamecardContact(g, 'E', data.email, 128);

    drawNamecardWordmark(g, 43, 428, 70, '#050505', NAMECARD_BLUE, '600');
    g.fillStyle = '#111111';
    g.font = namecardFont(12, '800', 'en');
    drawNamecardTrackedText(g, 'PEAK MARKETING', 46, 456, 3.6);

    NAMECARD_ADDRESSES.forEach((row, index) => drawNamecardAddress(g, row[0], row[1], 335 + index * 48));
  }

  function drawNamecard(data) {
    const canvas = document.getElementById('namecardCanvas');
    if (!canvas) return;
    const g = setupNamecardCanvas(canvas);
    drawNamecardBrandPanel(g);
    g.save();
    g.translate(0, NAMECARD_SIDE_HEIGHT);
    drawNamecardInfoPanel(g, data);
    g.restore();
  }

  function safeNamecardFilename(value) {
    const cleaned = String(value || '')
      .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '')
      .trim()
      .replace(/[. ]+$/g, '');
    const shortened = [...cleaned].slice(0, 40).join('');
    if (!shortened || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(shortened)) return '이름';
    return shortened;
  }

  function renderNamecardModule() {
    const roster = orgRoster();
    const me = roster.find(row => row.name === String(userDoc?.name || '').trim());
    if (!namecardInitialized) {
      namecardForm = {
        name: String(userDoc?.name || '').trim(),
        englishName: '',
        rank: me ? orgRankOf(me) : '',
        team: me ? orgDisplayName(me.teamName || me.divisionName) : '',
        phone: '',
        email: String(userDoc?.email || currentUser?.email || '').trim()
      };
      namecardInitialized = true;
    }
    if (namecardForm.englishName === undefined) namecardForm.englishName = '';
    const form = namecardForm;

    moduleView.innerHTML = `
      ${moduleStatusbar('명함', '실제 명함 디자인의 브랜드 면과 정보 면을 한 장의 이미지로 만듭니다.', '한 장 PNG')}
      <section class="module-section">
        <div class="module-section-head">
          <span><strong>명함 정보</strong><small>이름과 직급은 조직도에서 가져왔습니다. 영문 이름과 연락처를 확인하세요</small></span>
          <span class="module-chip live">1800 × 2000 PNG</span>
        </div>
        <div class="module-section-body">
          <div class="intake-form">
            <label class="intake-field"><span>이름</span><input type="text" data-card="name" value="${esc(form.name)}"></label>
            <label class="intake-field"><span>영문 이름</span><input type="text" data-card="englishName" value="${esc(form.englishName)}" placeholder="English Name"></label>
            <label class="intake-field"><span>직급</span><input type="text" data-card="rank" value="${esc(form.rank)}"></label>
            <label class="intake-field"><span>소속</span><input type="text" data-card="team" value="${esc(form.team)}"></label>
            <label class="intake-field"><span>휴대폰</span><input type="text" data-card="phone" value="${esc(form.phone)}" placeholder="010-0000-0000"></label>
            <label class="intake-field"><span>이메일</span><input type="text" data-card="email" value="${esc(form.email)}" placeholder="name@peak.kr"></label>
          </div>
        </div>
      </section>
      <section class="module-section" style="max-width:960px;margin-inline:auto">
        <div class="module-section-head"><span><strong>명함 한 장 미리보기</strong><small>브랜드 영역과 입력 정보가 한 이미지에 이어집니다</small></span><span class="module-chip live">단일 이미지</span></div>
        <div class="module-section-body">
          <div class="est-preview" style="max-width:900px;margin-inline:auto"><canvas id="namecardCanvas" aria-label="한 장으로 합친 명함 미리보기"></canvas></div>
          <div class="intake-foot">
            <p class="sales-basis">위 정보를 입력하면 흰색 정보 영역에 바로 반영됩니다.</p>
            <button class="module-action primary" type="button" data-card-download>명함 PNG 저장</button>
          </div>
        </div>
      </section>`;

    drawNamecard(form);
  }

  // 자금 현황판. 대표님 시트를 그대로 옮겼다.
  //   현잔고 + 영업자 미수금 - (공급처 입금 + 선결제) = 실질적으로 남은 금액
  //   여기서 월급을 빼면 실제 통장 잔여 금액이 된다.
  const FUND_MEMBERS = ['회사', '박종원', '김대호', '김지홍', '박우진', '김주현', '김용일', '은시후'];
  const FUND_BANKS = ['리워드스페이스', '리뷰스페이스', '매출', '공급처', '고정비용'];
  const FUND_KEY = 'peakos.fundBoard';

  let fundBoard = null;

  function emptyFundBoard() {
    const perMember = () => FUND_MEMBERS.reduce((acc, name) => ({ ...acc, [name]: { total: '', cur: '', prev: '' } }), {});
    return {
      // 26-07 처럼 시트에 쓰던 표기를 그대로 둔다
      curLabel: '',
      prevLabel: '',
      banks: FUND_BANKS.reduce((acc, name) => ({ ...acc, [name]: '' }), {}),
      ar: perMember(),
      prepaid: perMember(),
      payroll: FUND_MEMBERS.reduce((acc, name) => ({ ...acc, [name]: '' }), {}),
      vendors: []
    };
  }

  function localFundBoard() {
    try {
      const saved = JSON.parse(localStorage.getItem(FUND_KEY) || 'null');
      return saved && typeof saved === 'object' ? saved : null;
    } catch (error) {
      return null;
    }
  }

  async function loadFundBoard() {
    if (!canSeeTeamSettlement()) { fundBoard = emptyFundBoard(); return; }
    try {
      const saved = await readOnlyApi('/peakos/fund');
      fundBoard = saved && typeof saved === 'object' ? { ...emptyFundBoard(), ...saved } : emptyFundBoard();
      // 사람이 늘어도 칸이 비지 않게 채운다
      ['ar', 'prepaid'].forEach(key => {
        FUND_MEMBERS.forEach(name => {
          if (!fundBoard[key][name]) fundBoard[key][name] = { total: '', cur: '', prev: '' };
        });
      });
      FUND_MEMBERS.forEach(name => {
        if (fundBoard.payroll[name] === undefined) fundBoard.payroll[name] = '';
      });
      FUND_BANKS.forEach(name => {
        if (fundBoard.banks[name] === undefined) fundBoard.banks[name] = '';
      });
    } catch (error) {
      fundBoard = emptyFundBoard();
    }
  }

  // 숫자를 칠 때마다 보내면 요청이 쏟아진다. 잠깐 모았다가 한 번에 보낸다.
  // 대신 창을 닫거나 새로고침할 때는 남은 것을 바로 밀어 넣는다.
  let fundSaveTimer = null;
  let fundSavePending = false;

  async function pushFundBoard() {
    fundSavePending = false;
    try {
      await callApi('PUT', '/peakos/fund', { board: fundBoard });
    } catch (error) {
      console.error('자금 현황 저장 실패:', error.message);
      showToast(`저장하지 못했습니다. ${error.message}`);
    }
  }

  function saveFundBoard() {
    fundSavePending = true;
    clearTimeout(fundSaveTimer);
    fundSaveTimer = setTimeout(pushFundBoard, 400);
  }

  function flushFundBoard() {
    if (!fundSavePending) return;
    clearTimeout(fundSaveTimer);
    pushFundBoard();
  }

  // 화면을 떠날 때 아직 못 보낸 값이 있으면 지금 보낸다.
  window.addEventListener('pagehide', flushFundBoard);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushFundBoard();
  });

  const won = value => (Number(value) || 0).toLocaleString('ko-KR');
  const sumOf = (obj, field) => Object.values(obj).reduce((sum, item) => sum + (Number(field ? item[field] : item) || 0), 0);

  function fundSummary() {
    const bank = sumOf(fundBoard.banks);
    const ar = sumOf(fundBoard.ar, 'total');
    const prepaid = sumOf(fundBoard.prepaid, 'total');
    const vendor = fundBoard.vendors.reduce((sum, row) => sum + (Number(row.total) || 0), 0);
    const payroll = sumOf(fundBoard.payroll);
    const real = bank + ar - (vendor + prepaid);
    return { bank, ar, prepaid, vendor, payroll, real, afterPayroll: real - payroll };
  }

  function fundMoneyRow(group, name, fields) {
    return fields.map(field => `<td><input class="fund-input" type="number" data-fund-money="${esc(group)}" data-fund-name="${esc(name)}" data-fund-field="${esc(field)}" value="${esc(String(fundBoard[group][name][field] ?? ''))}" placeholder="0" aria-label="${esc(name)} ${esc(field)}"></td>`).join('');
  }

  // 숫자를 칠 때마다 화면 전체를 다시 그리면 아직 change 가 안 난 칸의 값이
  // 날아간다. 합계 칸만 갈아 끼운다.
  function fundSync() {
    const sum = fundSummary();
    const out = {
      bank: sum.bank, ar: sumOf(fundBoard.ar, 'total'), 'ar-cur': sumOf(fundBoard.ar, 'cur'), 'ar-prev': sumOf(fundBoard.ar, 'prev'),
      prepaid: sumOf(fundBoard.prepaid, 'total'), 'prepaid-cur': sumOf(fundBoard.prepaid, 'cur'), 'prepaid-prev': sumOf(fundBoard.prepaid, 'prev'),
      vendor: sum.vendor,
      'vendor-cur': fundBoard.vendors.reduce((acc, row) => acc + (Number(row.cur) || 0), 0),
      'vendor-prev': fundBoard.vendors.reduce((acc, row) => acc + (Number(row.prev) || 0), 0),
      payroll: sum.payroll, real: sum.real, after: sum.afterPayroll
    };
    moduleView.querySelectorAll('[data-fund-out]').forEach(node => {
      const key = node.dataset.fundOut;
      if (out[key] !== undefined) node.textContent = won(out[key]);
    });
  }

  function renderReceivableModule() {
    if (!canSeeTeamSettlement()) {
      moduleView.innerHTML = `
        ${moduleStatusbar('미수금 현황', '지정된 인원만 볼 수 있습니다.', '접근 제한')}
        <section class="module-section">
          <div class="module-section-head"><span><strong>열람 권한이 없습니다</strong><small>회사 자금 현황은 지정된 세 사람만 봅니다</small></span><span class="module-chip restricted">지정 인원 전용</span></div>
          <div class="module-section-body"><p class="sales-state">김진봉 대표 · 김대호 부장 · 박종원 부장만 볼 수 있습니다.</p></div>
        </section>`;
      return;
    }
    if (!fundBoard) fundBoard = emptyFundBoard();

    const sum = fundSummary();
    const cur = fundBoard.curLabel || '당월';
    const prev = fundBoard.prevLabel || '전월';

    moduleView.innerHTML = `
      ${moduleStatusbar('미수금 현황', '통장 잔고와 받을 돈, 줄 돈을 모아 실제로 남는 금액을 봅니다.', `실질 ${won(sum.real)}원`)}

      <section class="module-section">
        <div class="module-section-head">
          <span><strong>요약</strong><small>현잔고 + 영업자 미수금 − (공급처 입금 + 선결제) = 실질적으로 남은 금액</small></span>
          <span class="module-chip live">총 통장 잔고 ${esc(won(sum.bank))}원</span>
        </div>
        <div class="module-section-body">
          <div class="fund-cards">
            <article class="fund-card"><span>총 통장 잔고</span><strong data-fund-out="bank">${esc(won(sum.bank))}</strong></article>
            <article class="fund-card"><span>영업자 총 미수금</span><strong data-fund-out="ar">${esc(won(sum.ar))}</strong></article>
            <article class="fund-card warn"><span>공급처 입금 해야할 예상 금액</span><strong data-fund-out="vendor">${esc(won(sum.vendor))}</strong></article>
            <article class="fund-card warn"><span>선결제 금액</span><strong data-fund-out="prepaid">${esc(won(sum.prepaid))}</strong></article>
            <article class="fund-card strong"><span>실질적으로 남은 금액</span><strong data-fund-out="real">${esc(won(sum.real))}</strong></article>
            <article class="fund-card"><span>월급 뺀 실제 잔여</span><strong data-fund-out="after">${esc(won(sum.afterPayroll))}</strong><small>급여 <em data-fund-out="payroll">${esc(won(sum.payroll))}</em></small></article>
          </div>
          <div class="fund-period">
            <label class="ledger-filter-field"><span>당월 표기</span>
              <input type="text" data-fund-label="curLabel" value="${esc(fundBoard.curLabel)}" placeholder="26-07"></label>
            <label class="ledger-filter-field"><span>전월 표기</span>
              <input type="text" data-fund-label="prevLabel" value="${esc(fundBoard.prevLabel)}" placeholder="26-06"></label>
          </div>
        </div>
      </section>

      <section class="module-section">
        <div class="module-section-head"><span><strong>통장 잔고</strong><small>통장별로 현재 잔고를 넣습니다</small></span></div>
        <div class="module-section-body">
          <div class="sales-table-scroll">
            <table class="sales-table fund-table">
              <thead><tr>${FUND_BANKS.map(name => `<th scope="col">${esc(name)}통장</th>`).join('')}<th scope="col">총 잔고</th></tr></thead>
              <tbody><tr>
                ${FUND_BANKS.map(name => `<td><input class="fund-input" type="number" data-fund-bank="${esc(name)}" value="${esc(String(fundBoard.banks[name] ?? ''))}" placeholder="0" aria-label="${esc(name)}통장 잔고"></td>`).join('')}
                <td class="sales-cell-total" data-fund-out="bank">${esc(won(sum.bank))}</td>
              </tr></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="module-section">
        <div class="module-section-head">
          <span><strong>영업자 미수금</strong><small>영업자별로 아직 못 받은 돈</small></span>
          <span class="module-chip ${sum.ar ? 'restricted' : 'live'}">총 ${esc(won(sum.ar))}원</span>
        </div>
        <div class="module-section-body">
          <div class="sales-table-scroll">
            <table class="sales-table fund-table">
              <thead><tr><th scope="col">영업자</th><th scope="col">총합 미수금</th><th scope="col">${esc(cur)} 미수금</th><th scope="col">${esc(prev)} 미수금</th></tr></thead>
              <tbody>
                ${FUND_MEMBERS.map(name => `<tr><th scope="row">${esc(name)}</th>${fundMoneyRow('ar', name, ['total', 'cur', 'prev'])}</tr>`).join('')}
                <tr class="fund-sum"><th scope="row">합계</th><td data-fund-out="ar">${esc(won(sumOf(fundBoard.ar, 'total')))}</td><td data-fund-out="ar-cur">${esc(won(sumOf(fundBoard.ar, 'cur')))}</td><td data-fund-out="ar-prev">${esc(won(sumOf(fundBoard.ar, 'prev')))}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="module-section">
        <div class="module-section-head"><span><strong>선결제 금액</strong><small>미리 받아 둔 돈이라 남은 금액에서 뺍니다</small></span></div>
        <div class="module-section-body">
          <div class="sales-table-scroll">
            <table class="sales-table fund-table">
              <thead><tr><th scope="col">영업자</th><th scope="col">총합 선결제</th><th scope="col">${esc(cur)} 선결제</th><th scope="col">${esc(prev)} 선결제</th></tr></thead>
              <tbody>
                ${FUND_MEMBERS.map(name => `<tr><th scope="row">${esc(name)}</th>${fundMoneyRow('prepaid', name, ['total', 'cur', 'prev'])}</tr>`).join('')}
                <tr class="fund-sum"><th scope="row">합계</th><td data-fund-out="prepaid">${esc(won(sumOf(fundBoard.prepaid, 'total')))}</td><td data-fund-out="prepaid-cur">${esc(won(sumOf(fundBoard.prepaid, 'cur')))}</td><td data-fund-out="prepaid-prev">${esc(won(sumOf(fundBoard.prepaid, 'prev')))}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="module-section">
        <div class="module-section-head">
          <span><strong>공급처 입금 예정 금액</strong><small>대행사별로 우리가 보내야 할 돈</small></span>
          <span class="module-chip ${sum.vendor ? 'restricted' : 'live'}">총 ${esc(won(sum.vendor))}원</span>
        </div>
        <div class="module-section-body">
          <div class="sales-table-scroll">
            <table class="sales-table fund-table">
              <thead><tr><th scope="col">대행사</th><th scope="col">총합</th><th scope="col">${esc(cur)}</th><th scope="col">${esc(prev)}</th><th scope="col" aria-label="삭제"></th></tr></thead>
              <tbody>
                ${fundBoard.vendors.length ? fundBoard.vendors.map((row, index) => `<tr>
                  <th scope="row"><input class="fund-input wide" type="text" list="fundVendorList" data-fund-vendor="name" data-fund-index="${index}" value="${esc(row.name || '')}" placeholder="대행사명" aria-label="대행사명"></th>
                  <td><input class="fund-input" type="number" data-fund-vendor="total" data-fund-index="${index}" value="${esc(String(row.total ?? ''))}" placeholder="0" aria-label="총합"></td>
                  <td><input class="fund-input" type="number" data-fund-vendor="cur" data-fund-index="${index}" value="${esc(String(row.cur ?? ''))}" placeholder="0" aria-label="당월"></td>
                  <td><input class="fund-input" type="number" data-fund-vendor="prev" data-fund-index="${index}" value="${esc(String(row.prev ?? ''))}" placeholder="0" aria-label="전월"></td>
                  <td><button class="ledger-remove" type="button" data-fund-vendor-remove="${index}" aria-label="줄 삭제">✕</button></td>
                </tr>`).join('') : '<tr><td colspan="5" class="ledger-memo-empty">아래 버튼으로 대행사를 추가하세요.</td></tr>'}
                <tr class="fund-sum"><th scope="row">합계</th>
                  <td data-fund-out="vendor">${esc(won(sum.vendor))}</td>
                  <td data-fund-out="vendor-cur">${esc(won(fundBoard.vendors.reduce((acc, row) => acc + (Number(row.cur) || 0), 0)))}</td>
                  <td data-fund-out="vendor-prev">${esc(won(fundBoard.vendors.reduce((acc, row) => acc + (Number(row.prev) || 0), 0)))}</td><td></td></tr>
              </tbody>
            </table>
          </div>
          <datalist id="fundVendorList">${SUPPLIERS.map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist>
          <div class="intake-foot">
            <p class="sales-basis">공급사 정산 탭에서 아직 지불하지 않은 금액이 여기로 오게 잇는 것은 서버 저장이 붙은 뒤에 합니다.</p>
            <button class="module-action" type="button" data-fund-vendor-add>＋ 대행사 추가</button>
          </div>
        </div>
      </section>

      <section class="module-section">
        <div class="module-section-head">
          <span><strong>급여 정산 예정 금액</strong><small>대표님 작성란 · 월급 결산 후</small></span>
          <span class="module-chip restricted">대표 작성</span>
        </div>
        <div class="module-section-body">
          <div class="sales-table-scroll">
            <table class="sales-table fund-table">
              <thead><tr><th scope="col">영업자</th><th scope="col">정산 금액</th></tr></thead>
              <tbody>
                ${FUND_MEMBERS.map(name => `<tr><th scope="row">${esc(name)}</th>
                  <td><input class="fund-input" type="number" data-fund-payroll="${esc(name)}" value="${esc(String(fundBoard.payroll[name] ?? ''))}" placeholder="0" aria-label="${esc(name)} 정산 금액"></td></tr>`).join('')}
                <tr class="fund-sum"><th scope="row">합계</th><td data-fund-out="payroll">${esc(won(sum.payroll))}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <div class="module-security"><span>▣</span><span><strong>계산식</strong><br>현잔고 <em data-fund-out="bank">${esc(won(sum.bank))}</em> + 영업자 미수금 <em data-fund-out="ar">${esc(won(sum.ar))}</em> − (공급처 입금 <em data-fund-out="vendor">${esc(won(sum.vendor))}</em> + 선결제 <em data-fund-out="prepaid">${esc(won(sum.prepaid))}</em>) = <strong>실질적으로 남은 금액 <em data-fund-out="real">${esc(won(sum.real))}</em></strong> − 월급 <em data-fund-out="payroll">${esc(won(sum.payroll))}</em> = 실제 통장 잔여 <em data-fund-out="after">${esc(won(sum.afterPayroll))}</em></span></div>`;
  }

  // 아이디어 · 개발수정요청 — 기존 파라곤에 쌓인 내용을 그대로 읽어 온다.
  // 새로 옮기는 게 아니라 같은 DB 를 보는 것이라 내용이 그대로 나온다.
  let liveIdeas = [];
  let liveRequests = [];
  let ideaCategory = '';
  let requestStatus = '';

  const REQUEST_STATUS = {
    requested: '요청',
    reviewing: '검토 중',
    working: '진행 중',
    done: '완료',
    rejected: '반려'
  };
  const REQUEST_PRIORITY = { urgent: '긴급', high: '높음', normal: '보통', low: '낮음' };

  async function loadIdeaData() {
    const [ideas, requestPayload] = await Promise.all([
      readOnlyApi('/ideas').catch(() => []),
      readOnlyApi('/service-requests').catch(() => [])
    ]);
    liveIdeas = Array.isArray(ideas) ? ideas : [];
    const requests = Array.isArray(requestPayload)
      ? requestPayload
      : (Array.isArray(requestPayload?.requests) ? requestPayload.requests : []);
    liveRequests = requests.filter(row => !row.deleted);
  }

  function renderIdeaModule() {
    const cats = [...new Set(liveIdeas.map(row => row.category).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'ko'));
    const shown = ideaCategory ? liveIdeas.filter(row => row.category === ideaCategory) : liveIdeas;
    const option = (value, label, selected) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;

    moduleView.innerHTML = `
      ${moduleStatusbar('아이디어', '파라곤에 쌓아 온 아이디어를 그대로 봅니다.', `${liveIdeas.length}건`)}
      <section class="module-section">
        <div class="module-section-head">
          <span><strong>아이디어</strong><small>${ideaCategory ? `${esc(ideaCategory)} · ` : ''}${esc(String(shown.length))}건${ideaCategory ? ` / 전체 ${liveIdeas.length}건` : ''}</small></span>
          <span class="module-chip live">읽기 전용</span>
        </div>
        <div class="module-section-body">
          <div class="ledger-filter">
            <label class="ledger-filter-field">
              <span>분류</span>
              <select data-idea-category>
                ${option('', '전체', ideaCategory)}
                ${cats.map(name => option(name, name, ideaCategory)).join('')}
              </select>
            </label>
          </div>
          ${shown.length ? `<div class="idea-list">
            ${shown.map(row => `<article class="idea-card">
              <div class="idea-card-head">
                <strong>${esc(row.title || '제목 없음')}</strong>
                ${row.category ? `<span class="kind-badge added">${esc(row.category)}</span>` : ''}
              </div>
              ${row.summary ? `<p class="idea-summary">${esc(row.summary)}</p>` : ''}
              ${row.detail ? `<p class="idea-detail">${esc(row.detail)}</p>` : ''}
              <div class="idea-card-foot">
                <span>${esc(row.owner_name || '작성자 미상')}</span>
                <span>${esc(String(row.date || row.created_at || '').slice(0, 10))}</span>
                ${row.source ? `<span>출처 ${esc(row.source)}</span>` : ''}
                ${row.url ? `<a href="${esc(row.url)}" target="_blank" rel="noopener">링크</a>` : ''}
              </div>
            </article>`).join('')}
          </div>` : '<p class="sales-state">조회 조건에 맞는 아이디어가 없습니다.</p>'}
        </div>
      </section>
      <div class="module-security"><span>▣</span><span><strong>기존 파라곤과 같은 자료입니다</strong><br>옮겨 담은 것이 아니라 같은 곳을 읽습니다. 파라곤에서 고치면 여기에도 바로 반영됩니다.</span></div>`;
  }

  function renderRequestModule() {
    const shown = requestStatus ? liveRequests.filter(row => row.status === requestStatus) : liveRequests;
    const counts = Object.keys(REQUEST_STATUS).reduce((acc, key) => {
      acc[key] = liveRequests.filter(row => row.status === key).length;
      return acc;
    }, {});
    const open = liveRequests.filter(row => !['done', 'rejected'].includes(row.status)).length;

    moduleView.innerHTML = `
      ${moduleStatusbar('개발수정요청', '접수된 개발수정요청을 상태별로 봅니다.', `처리 대기 ${open}건`)}
      <section class="module-section">
        <div class="module-section-head">
          <span><strong>개발수정요청</strong><small>${esc(String(shown.length))}건${requestStatus ? ` / 전체 ${liveRequests.length}건` : ''}</small></span>
          <span class="module-chip ${open ? 'restricted' : 'live'}">처리 대기 ${esc(String(open))}건</span>
        </div>
        <div class="module-section-body">
          <div class="request-tabs">
            <button class="intake-kind-btn ${requestStatus === '' ? 'active' : ''}" type="button" data-request-status="">전체 ${esc(String(liveRequests.length))}</button>
            ${Object.entries(REQUEST_STATUS).map(([key, label]) =>
              `<button class="intake-kind-btn ${requestStatus === key ? 'active' : ''}" type="button" data-request-status="${esc(key)}">${esc(label)} ${esc(String(counts[key] || 0))}</button>`).join('')}
          </div>
          ${shown.length ? `<div class="sales-table-scroll">
            <table class="sales-table ledger-table">
              <thead><tr>
                <th scope="col">상태</th><th scope="col">우선순위</th><th scope="col">상품</th>
                <th scope="col">제목</th><th scope="col">요청자</th><th scope="col">담당</th><th scope="col">요청일</th>
              </tr></thead>
              <tbody>
                ${shown.map(row => `<tr>
                  <td><span class="vendor-chip ${['done'].includes(row.status) ? 'done' : ''}">${esc(REQUEST_STATUS[row.status] || row.status || '-')}</span></td>
                  <td class="${['urgent', 'high'].includes(row.priority) ? 'monthly-minus' : ''}">${esc(REQUEST_PRIORITY[row.priority] || row.priority || '-')}</td>
                  <td>${esc(row.product_name || '-')}</td>
                  <th scope="row">${esc(row.title || '제목 없음')}${row.content ? `<span class="request-note">${esc(String(row.content).slice(0, 60))}${String(row.content).length > 60 ? '…' : ''}</span>` : ''}</th>
                  <td>${esc(row.requester_name || '-')}</td>
                  <td class="${row.assignee_name ? '' : 'ledger-memo-empty'}">${esc(row.assignee_name || '미지정')}</td>
                  <td>${esc(String(row.created_at || '').slice(0, 10))}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>` : '<p class="sales-state">해당 상태의 개발수정요청이 없습니다.</p>'}
        </div>
      </section>
      <div class="module-security"><span>▣</span><span><strong>기존 파라곤과 같은 자료입니다</strong><br>옮겨 담은 것이 아니라 같은 곳을 읽습니다. 파라곤에서 상태를 바꾸면 여기에도 바로 반영됩니다.</span></div>`;
  }

  // 통장 조회 — 은행 수집기가 보관한 공개 필드만 지연 조회한다.
  // 화면에는 원본 응답을 절대 펼치지 않고 계좌번호도 한 번 더 마스킹한다.
  function emptyBankData() {
    return {
      status: 'idle',
      error: '',
      collectorConfigured: false,
      autoReconciliationEnabled: false,
      canSync: false,
      canViewBalances: false,
      accounts: [],
      transactions: [],
      summary: { total: 0, depositTotal: null, withdrawalTotal: null, unmatchedCount: 0 },
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
      runs: []
    };
  }

  function resetBankData({ clearOperation = false } = {}) {
    bankLoadGeneration += 1;
    bankLoadPromise = null;
    if (clearOperation) {
      bankSyncingAccountId = '';
      bankSelectedAccountId = '';
    }
    bankData = emptyBankData();
  }

  function maskedBankAccount(value) {
    const raw = String(value || '')
      .replace(/[^0-9*\-\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    const digits = raw.replace(/\D/g, '');
    if (!digits) return '계좌번호 미등록';
    // 서버가 이미 마스킹한 값은 별표와 일부 식별 숫자만 유지한다.
    if (raw.includes('*') && digits.length <= 8) return raw;
    const prefix = digits.slice(0, Math.min(2, digits.length));
    const suffix = digits.slice(-Math.min(4, digits.length));
    return `${prefix}-****-${suffix}`;
  }

  function bankMoney(value, fallback = '미수집') {
    if (value === null || value === undefined || value === '') return fallback;
    const amount = Number(value);
    if (!Number.isFinite(amount)) return fallback;
    return `${Math.round(amount).toLocaleString('ko-KR')}원`;
  }

  function bankDate(value) {
    if (!value) return '-';
    return formatDate(value, {
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Seoul'
    });
  }

  function bankBranchLabel(value) {
    return { hq: '본사', daegu: '대구지사', jeonju: '전주지사' }[String(value || '')] || String(value || '소속 미지정');
  }

  function bankTransactionStatus(value) {
    return {
      UNMATCHED: { label: '미분류', tone: 'warn' },
      PROPOSED: { label: '검토 필요', tone: 'review' },
      MATCHED: { label: '확인 완료', tone: 'done' },
      IGNORED: { label: '제외', tone: 'muted' },
      REVERSED: { label: '취소', tone: 'danger' }
    }[String(value || '').toUpperCase()] || { label: String(value || '미분류'), tone: 'muted' };
  }

  function bankRunStatus(value) {
    return {
      RUNNING: { label: '동기화 중', tone: 'review' },
      SUCCEEDED: { label: '성공', tone: 'done' },
      FAILED: { label: '실패', tone: 'danger' }
    }[String(value || '').toUpperCase()] || { label: String(value || '확인 필요'), tone: 'muted' };
  }

  function bankRunField(row, camel, snake) {
    return row?.[camel] ?? row?.[snake] ?? null;
  }

  async function loadBankData() {
    if (!canSeeBankLedger()) return;
    if (bankLoadPromise) return bankLoadPromise;
    const generation = bankLoadGeneration;
    bankData.status = 'loading';
    bankData.error = '';
    if (activeView === 'bank') renderPlannedModule('bank');

    const request = Promise.all([
      readOnlyApi('/peakos/bank/accounts'),
      readOnlyApi(`/peakos/bank/transactions?${bankPeriodQuery()}`),
      readOnlyApi('/peakos/bank/sync-runs')
    ]);
    bankLoadPromise = request;
    try {
      const [accountPayload, transactionPayload, runPayload] = await request;
      if (generation !== bankLoadGeneration || !canSeeBankLedger()) return;
      bankData = {
        status: 'ready',
        error: '',
        collectorConfigured: accountPayload?.collectorConfigured === true,
        autoReconciliationEnabled: accountPayload?.autoReconciliationEnabled === true,
        canSync: accountPayload?.canSync === true,
        canViewBalances: accountPayload?.canViewBalances === true,
        accounts: Array.isArray(accountPayload?.accounts) ? accountPayload.accounts : [],
        transactions: Array.isArray(transactionPayload?.transactions) ? transactionPayload.transactions : [],
        summary: {
          total: Number(transactionPayload?.summary?.total || 0),
          depositTotal: transactionPayload?.summary?.depositTotal ?? null,
          withdrawalTotal: transactionPayload?.summary?.withdrawalTotal ?? null,
          unmatchedCount: Number(transactionPayload?.summary?.unmatchedCount || 0)
        },
        pagination: transactionPayload?.pagination || { page: 1, limit: 100, total: 0, totalPages: 0 },
        runs: Array.isArray(runPayload?.runs) ? runPayload.runs : []
      };
    } catch (error) {
      if (generation !== bankLoadGeneration || !canSeeBankLedger()) return;
      bankData.status = 'error';
      bankData.error = error.message || '통장 자료를 불러오지 못했습니다.';
    } finally {
      if (bankLoadPromise === request) bankLoadPromise = null;
      if (generation === bankLoadGeneration && activeView === 'bank' && canSeeBankLedger()) {
        renderPlannedModule('bank');
      }
    }
    return bankData;
  }

  async function syncBankAccount(accountId) {
    if (!canSeeBankLedger() || previewPersona) return;
    if (!bankData.collectorConfigured || !bankData.canSync) {
      showToast('안전한 조회 전용 수집기가 아직 연결되지 않았습니다.');
      return;
    }
    const account = bankData.accounts.find(row => String(row.id) === String(accountId));
    if (!account || account.active === false || bankSyncingAccountId) return;
    bankSyncingAccountId = String(accountId);
    renderPlannedModule('bank');
    try {
      const result = await callApi('POST', `/peakos/bank/accounts/${encodeURIComponent(accountId)}/sync`, {});
      showToast(`통장 조회 완료 · 신규 ${Number(result.inserted || 0).toLocaleString('ko-KR')}건`);
      await loadBankData();
    } catch (error) {
      showToast(`통장 조회 실패: ${error.message}`);
    } finally {
      bankSyncingAccountId = '';
      if (activeView === 'bank' && canSeeBankLedger()) renderPlannedModule('bank');
    }
  }

  function renderBankLoading(error = '') {
    moduleView.innerHTML = `<div class="bank-ledger" data-bank-ledger>
        ${moduleStatusbar('통장별 거래내역', '계좌별 최근 입출금 내역을 조회합니다.', '승인 직원 · 조회 전용')}
      ${renderFinancePeriodFilter('bank', '한국시간 거래일 기준 · 잔액 카드는 현재 잔액')}
      <section class="module-section">
        <div class="module-section-body">
          <div class="bank-load-state ${error ? 'error' : ''}" ${error ? 'data-bank-error' : 'data-bank-loading'}>
            <span class="bank-load-icon" aria-hidden="true">${error ? '!' : '↻'}</span>
            <strong>${error ? '통장 자료를 불러오지 못했습니다' : '통장 자료를 불러오고 있습니다'}</strong>
            <small>${esc(error || '권한이 확인된 뒤 필요한 자료만 안전하게 조회합니다.')}</small>
            ${error ? '<button class="module-action" type="button" data-bank-retry>다시 조회</button>' : ''}
          </div>
        </div>
      </section>
    </div>`;
  }

  function renderBankModule() {
    if (!canSeeBankLedger()) {
      moduleView.innerHTML = `<div class="bank-ledger" data-bank-ledger>
        ${moduleStatusbar('통장별 거래내역', '승인된 실제 로그인 계정에서만 볼 수 있습니다.', '접근 제한')}
        <section class="module-section"><div class="module-section-body"><p class="sales-state">통장 원장 열람 권한이 없습니다.</p></div></section>
      </div>`;
      return;
    }
    if (bankData.status === 'idle') {
      renderBankLoading();
      Promise.resolve().then(() => loadBankData());
      return;
    }
    if (bankData.status === 'loading') {
      renderBankLoading();
      return;
    }
    if (bankData.status === 'error') {
      renderBankLoading(bankData.error);
      return;
    }

    const accounts = bankData.accounts;
    const transactions = bankData.transactions;
    const runs = bankData.runs;
    const accountById = new Map(accounts.map(row => [String(row.id), row]));
    const accountName = id => accountById.get(String(id))?.displayName || '등록 통장';
    const balances = bankData.canViewBalances ? accounts
      .filter(row => row.latestBalance !== null && row.latestBalance !== undefined && row.latestBalance !== '')
      .map(row => Number(row.latestBalance))
      .filter(value => Number.isFinite(value)) : [];
    const totalBalance = balances.reduce((sum, value) => sum + value, 0);
    const summary = bankData.summary;
    const transactionStatus = row => bankTransactionStatus(row.status);
    const directionLabel = row => String(row.direction).toUpperCase() === 'DEPOSIT' ? '입금' : '출금';
    const directionTone = row => String(row.direction).toUpperCase() === 'DEPOSIT' ? 'deposit' : 'withdrawal';
    const signedAmount = row => `${String(row.direction).toUpperCase() === 'DEPOSIT' ? '+' : '−'} ${bankMoney(row.amount, '0원')}`;
    const syncAccounts = accounts.filter(row => row.active !== false && row.canSync !== false);
    if (!syncAccounts.some(row => String(row.id) === bankSelectedAccountId)) {
      bankSelectedAccountId = String(syncAccounts[0]?.id || '');
    }
    const syncAvailable = bankData.collectorConfigured && bankData.canSync && Boolean(bankSelectedAccountId);

    const accountCards = accounts.map(row => {
      return `<article class="bank-account-card" data-bank-account="${esc(row.id)}">
        <div class="bank-account-head">
          <span><strong>${esc(row.displayName || '이름 없는 통장')}</strong><small>${esc(row.bankName || row.provider || '은행 미등록')} · ${esc(bankBranchLabel(row.branchId))}</small></span>
          <span class="bank-account-state ${row.active === false ? 'inactive' : ''}">${row.active === false ? '중지' : '사용 중'}</span>
        </div>
        <span class="bank-account-number">${esc(maskedBankAccount(row.accountNumberMasked))}</span>
        ${bankData.canViewBalances ? `<div class="bank-account-balance"><span>최근 잔액</span><strong>${esc(bankMoney(row.latestBalance))}</strong><small>${esc(row.latestBalanceAt ? `${bankDate(row.latestBalanceAt)} 기준` : '잔액 수집 전')}</small></div>` : ''}
        <div class="bank-account-foot">
          <span class="bank-unmatched ${Number(row.unmatchedCount || 0) ? 'warn' : ''}">누적 미분류 ${Number(row.unmatchedCount || 0).toLocaleString('ko-KR')}건</span>
          <span>${esc(row.lastSyncSucceededAt ? `최근 성공 ${bankDate(row.lastSyncSucceededAt)}` : '동기화 이력 없음')}</span>
        </div>
      </article>`;
    }).join('');

    const transactionRows = transactions.map(row => {
      const status = transactionStatus(row);
      const account = accountName(row.accountId);
      const counterpartyAccount = row.counterpartyAccountMasked ? maskedBankAccount(row.counterpartyAccountMasked) : '';
      return `<tr>
        <td>${esc(bankDate(row.transactionAt))}</td>
        <th scope="row">${esc(account)}</th>
        <td><span class="bank-direction ${directionTone(row)}">${directionLabel(row)}</span></td>
        <td class="bank-amount ${directionTone(row)}">${esc(signedAmount(row))}</td>
        ${bankData.canViewBalances ? `<td>${esc(bankMoney(row.balance))}</td>` : ''}
        <td class="bank-transaction-copy"><strong>${esc(row.counterpartyName || row.summary || '-')}</strong><small>${esc([row.summary && row.counterpartyName ? row.summary : '', counterpartyAccount].filter(Boolean).join(' · ') || '-')}</small></td>
        <td><span class="bank-status ${status.tone}">${esc(status.label)}</span></td>
      </tr>`;
    }).join('');

    const transactionCards = transactions.map(row => {
      const status = transactionStatus(row);
      const counterpartyAccount = row.counterpartyAccountMasked ? maskedBankAccount(row.counterpartyAccountMasked) : '';
      return `<article class="bank-transaction-card">
        <div class="bank-mobile-head"><span class="bank-direction ${directionTone(row)}">${directionLabel(row)}</span><span class="bank-status ${status.tone}">${esc(status.label)}</span></div>
        <strong class="bank-mobile-amount ${directionTone(row)}">${esc(signedAmount(row))}</strong>
        <div class="bank-mobile-party"><strong>${esc(row.counterpartyName || row.summary || '-')}</strong><small>${esc([row.summary && row.counterpartyName ? row.summary : '', counterpartyAccount].filter(Boolean).join(' · ') || '-')}</small></div>
        <dl class="bank-mobile-meta">
          <div><dt>통장</dt><dd>${esc(accountName(row.accountId))}</dd></div>
          ${bankData.canViewBalances ? `<div><dt>거래 후 잔액</dt><dd>${esc(bankMoney(row.balance))}</dd></div>` : ''}
          <div><dt>거래일시</dt><dd>${esc(bankDate(row.transactionAt))}</dd></div>
        </dl>
      </article>`;
    }).join('');

    const runRows = runs.map(row => {
      const status = bankRunStatus(bankRunField(row, 'status', 'status'));
      const accountId = bankRunField(row, 'accountId', 'account_id');
      const startedAt = bankRunField(row, 'startedAt', 'started_at');
      const finishedAt = bankRunField(row, 'finishedAt', 'finished_at');
      const fetched = Number(bankRunField(row, 'fetchedCount', 'fetched_count') || 0);
      const inserted = Number(bankRunField(row, 'insertedCount', 'inserted_count') || 0);
      const updated = Number(bankRunField(row, 'updatedCount', 'updated_count') || 0);
      const requester = bankRunField(row, 'requestedByName', 'requested_by_name') || (bankRunField(row, 'triggerType', 'trigger_type') === 'MANUAL' ? '사용자' : '자동');
      const error = String(bankRunField(row, 'errorMessage', 'error_message') || '').slice(0, 120);
      return `<tr>
        <th scope="row">${esc(accountName(accountId))}</th>
        <td><span class="bank-status ${status.tone}">${esc(status.label)}</span></td>
        <td>${esc(bankRunField(row, 'triggerType', 'trigger_type') === 'MANUAL' ? '수동' : '자동')}</td>
        <td>${esc(bankDate(startedAt))}</td>
        <td>${esc(finishedAt ? bankDate(finishedAt) : '-')}</td>
        <td>조회 ${fetched.toLocaleString('ko-KR')} · 신규 ${inserted.toLocaleString('ko-KR')} · 갱신 ${updated.toLocaleString('ko-KR')}</td>
        <td class="bank-run-note"><strong>${esc(requester)}</strong>${error ? `<small>${esc(error)}</small>` : ''}</td>
      </tr>`;
    }).join('');

    const runCards = runs.map(row => {
      const status = bankRunStatus(bankRunField(row, 'status', 'status'));
      const accountId = bankRunField(row, 'accountId', 'account_id');
      const fetched = Number(bankRunField(row, 'fetchedCount', 'fetched_count') || 0);
      const inserted = Number(bankRunField(row, 'insertedCount', 'inserted_count') || 0);
      const updated = Number(bankRunField(row, 'updatedCount', 'updated_count') || 0);
      const requester = bankRunField(row, 'requestedByName', 'requested_by_name') || (bankRunField(row, 'triggerType', 'trigger_type') === 'MANUAL' ? '사용자' : '자동');
      const error = String(bankRunField(row, 'errorMessage', 'error_message') || '').slice(0, 120);
      return `<article class="bank-sync-card">
        <div class="bank-mobile-head"><strong>${esc(accountName(accountId))}</strong><span class="bank-status ${status.tone}">${esc(status.label)}</span></div>
        <span class="bank-sync-time">${esc(bankDate(bankRunField(row, 'startedAt', 'started_at')))}</span>
        <p>조회 ${fetched.toLocaleString('ko-KR')} · 신규 ${inserted.toLocaleString('ko-KR')} · 갱신 ${updated.toLocaleString('ko-KR')}</p>
        <span class="bank-sync-requester">요청 ${esc(requester)}</span>
        ${error ? `<small>${esc(error)}</small>` : ''}
      </article>`;
    }).join('');

    moduleView.innerHTML = `<div class="bank-ledger" data-bank-ledger>
      ${moduleStatusbar('통장별 거래내역', '일반 직원은 매출·리뷰·리워드 3계좌, 지정 재무 담당자는 전체 5계좌를 조회합니다.', '조회 전용')}
      ${renderFinancePeriodFilter('bank', '한국시간 거래일 기준 · 잔액 카드는 현재 잔액')}

      <section class="bank-kpis" aria-label="통장 거래 요약">
        ${bankData.canViewBalances ? `<article class="bank-kpi"><span>통장 잔액 합계</span><strong>${esc(balances.length ? bankMoney(totalBalance, '0원') : '미수집')}</strong><small>${accounts.length.toLocaleString('ko-KR')}개 계좌</small></article>` : ''}
        <article class="bank-kpi deposit"><span>조회 기간 입금</span><strong>${esc(bankMoney(summary.depositTotal, bankData.canViewBalances ? '0원' : '열람 제한'))}</strong><small>${esc(financePeriodLabel())}</small></article>
        <article class="bank-kpi withdrawal"><span>조회 기간 출금</span><strong>${esc(bankMoney(summary.withdrawalTotal, bankData.canViewBalances ? '0원' : '열람 제한'))}</strong><small>${esc(financePeriodLabel())}</small></article>
        <article class="bank-kpi warn"><span>미분류 거래</span><strong>${Number(summary.unmatchedCount || 0).toLocaleString('ko-KR')}건</strong><small>확인이 필요한 거래</small></article>
      </section>

      ${bankData.autoReconciliationEnabled
        ? '<div class="module-security"><span>✓</span><span><strong>자동 입금확인 정책이 활성화되어 있습니다</strong><br>안정 거래번호가 있는 입금만 검증 규칙을 통과한 뒤 자동 처리합니다.</span></div>'
        : '<div class="module-security"><span>!</span><span><strong>조회·동기화만 운영 중입니다</strong><br>IBK 공식 거래번호가 확인될 때까지 자동 입금확인과 충전금 승인은 안전상 보류합니다.</span></div>'}

      <section class="module-section">
        <div class="module-section-head bank-section-head">
          <span><strong>${bankData.canViewBalances ? '계좌와 최근 잔액' : '조회 계좌'}</strong><small>계좌번호는 모든 화면에서 일부만 표시합니다${bankData.canViewBalances ? '' : ' · 잔액은 지정 재무 담당자만 열람합니다'}</small></span>
          <div class="bank-section-actions">
            <span class="module-chip ${bankData.collectorConfigured ? 'live' : 'restricted'}">${bankData.collectorConfigured ? '조회 수집기 연결됨' : '조회 수집기 미설정'}</span>
            <span class="module-chip ${bankData.autoReconciliationEnabled ? 'live' : 'restricted'}">${bankData.autoReconciliationEnabled ? '자동 확인 사용' : '자동 확인 보류'}</span>
            ${syncAccounts.length > 1 && bankData.collectorConfigured && bankData.canSync ? `<label class="bank-sync-select"><span>동기화 통장</span><select data-bank-sync-account>${syncAccounts.map(row => `<option value="${esc(row.id)}" ${String(row.id) === bankSelectedAccountId ? 'selected' : ''}>${esc(row.displayName || '등록 통장')}</option>`).join('')}</select></label>` : ''}
            <button class="module-action bank-sync-button" type="button" data-bank-sync="${esc(bankSelectedAccountId)}" ${syncAvailable && !bankSyncingAccountId ? '' : 'disabled'} ${syncAvailable ? '' : 'hidden'}>${bankSyncingAccountId ? '동기화 중…' : '지금 동기화'}</button>
          </div>
        </div>
        <div class="module-section-body">
          ${accounts.length ? `<div class="bank-account-grid">${accountCards}</div>` : '<p class="sales-state">등록된 통장이 없습니다.</p>'}
        </div>
      </section>

      <section class="module-section">
        <div class="module-section-head bank-section-head">
          <span><strong>선택 기간 입출금</strong><small>${esc(financePeriodLabel())} · ${Number(bankData.pagination?.total ?? summary.total ?? 0).toLocaleString('ko-KR')}건 중 ${transactions.length.toLocaleString('ko-KR')}건</small></span>
          <div class="bank-section-actions"><span class="module-chip ${Number(summary.unmatchedCount || 0) ? 'restricted' : 'live'}">미분류 ${Number(summary.unmatchedCount || 0).toLocaleString('ko-KR')}건</span><button class="module-action" type="button" data-bank-refresh>새로고침</button></div>
        </div>
        <div class="module-section-body">
          ${transactions.length ? `<div class="sales-table-scroll bank-table-wrap">
            <table class="sales-table bank-transaction-table">
              <thead><tr><th scope="col">거래일시</th><th scope="col">통장</th><th scope="col">구분</th><th scope="col">금액</th>${bankData.canViewBalances ? '<th scope="col">거래 후 잔액</th>' : ''}<th scope="col">적요 · 상대방</th><th scope="col">분류</th></tr></thead>
              <tbody>${transactionRows}</tbody>
            </table>
          </div><div class="bank-transaction-cards">${transactionCards}</div>
          ${Number(bankData.pagination?.totalPages || 0) > 1 ? `<div class="bank-pagination" aria-label="통장 거래 페이지">
            <button class="module-action" type="button" data-bank-page="${Math.max(1, bankPage - 1)}" ${bankPage <= 1 ? 'disabled' : ''}>이전</button>
            <span>${bankPage.toLocaleString('ko-KR')} / ${Number(bankData.pagination.totalPages).toLocaleString('ko-KR')} 페이지</span>
            <button class="module-action" type="button" data-bank-page="${Math.min(Number(bankData.pagination.totalPages), bankPage + 1)}" ${bankPage >= Number(bankData.pagination.totalPages) ? 'disabled' : ''}>다음</button>
          </div>` : ''}` : '<p class="sales-state">선택한 기간의 입출금 내역이 없습니다.</p>'}
        </div>
      </section>

      <section class="module-section">
        <div class="module-section-head"><span><strong>동기화 이력</strong><small>최근 실행 30건</small></span></div>
        <div class="module-section-body">
          ${runs.length ? `<div class="sales-table-scroll bank-table-wrap"><table class="sales-table bank-sync-table">
            <thead><tr><th scope="col">통장</th><th scope="col">상태</th><th scope="col">실행</th><th scope="col">시작</th><th scope="col">완료</th><th scope="col">처리 결과</th><th scope="col">요청자 · 오류</th></tr></thead>
            <tbody>${runRows}</tbody>
          </table></div><div class="bank-sync-cards">${runCards}</div>` : '<p class="sales-state">동기화 이력이 아직 없습니다.</p>'}
        </div>
      </section>

      <div class="module-security"><span>▣</span><span><strong>조회 전용 통장 원장</strong><br>${bankData.canViewBalances ? '지정된 재무 담당자 권한으로 전체 운영 계좌와 잔액을 조회합니다.' : '현재 계정에는 매출통장·리뷰스페이스·리워드스페이스 거래만 제공하며 모든 잔액은 서버에서 제거합니다.'}</span></div>
    </div>`;
  }

  const PURCHASE_ACCOUNT_CONFIG = {
    'purchase-fixed': { accountId: 'ibk-hq-fixed', title: '고정비용통장', purpose: '광고비·비품·복리후생 매입' },
    'purchase-supplier': { accountId: 'ibk-hq-supplier', title: '공급처입금통장', purpose: '공급처 지급 매입' }
  };

  async function loadPurchaseLedger(view) {
    const config = PURCHASE_ACCOUNT_CONFIG[view];
    if (!config || !canSeeTaxPurchase()) return;
    purchaseLedgerState = {
      accountId: config.accountId, status: 'loading', account: null, transactions: [], error: '',
      pagination: { ...purchaseLedgerState.pagination, page: purchaseLedgerPage }
    };
    try {
      const [accountPayload, transactionPayload] = await Promise.all([
        readOnlyApi('/peakos/bank/accounts'),
        readOnlyApi(`/peakos/bank/transactions?${bankPeriodQuery(config.accountId, purchaseLedgerPage)}`)
      ]);
      if (activeView !== view || !canSeeTaxPurchase()) return;
      const accounts = Array.isArray(accountPayload?.accounts) ? accountPayload.accounts : [];
      purchaseLedgerState = {
        accountId: config.accountId,
        status: 'ready',
        account: accounts.find(row => String(row.id) === config.accountId) || null,
        transactions: Array.isArray(transactionPayload?.transactions) ? transactionPayload.transactions : [],
        error: '',
        pagination: transactionPayload?.pagination || { page: purchaseLedgerPage, limit: 100, total: 0, totalPages: 0 }
      };
    } catch (error) {
      purchaseLedgerState = {
        accountId: config.accountId, status: 'error', account: null, transactions: [],
        error: error.message || '매입 자료를 불러오지 못했습니다.',
        pagination: { page: purchaseLedgerPage, limit: 100, total: 0, totalPages: 0 }
      };
    }
  }

  function renderPurchaseTaxModule(view) {
    const config = PURCHASE_ACCOUNT_CONFIG[view];
    if (!config || !canSeeTaxPurchase()) {
      moduleView.innerHTML = `${moduleStatusbar('세금계산서 매입', '지정된 네 계정만 볼 수 있습니다.', '접근 제한')}<section class="module-section"><div class="module-section-body"><p class="sales-state">매입 자료 열람 권한이 없습니다.</p></div></section>`;
      return;
    }
    if (purchaseLedgerState.accountId !== config.accountId || purchaseLedgerState.status === 'idle') {
      if (purchaseLedgerState.accountId && purchaseLedgerState.accountId !== config.accountId) purchaseLedgerPage = 1;
      purchaseLedgerState = {
        accountId: config.accountId, status: 'loading', account: null, transactions: [], error: '',
        pagination: { page: purchaseLedgerPage, limit: 100, total: 0, totalPages: 0 }
      };
      moduleView.innerHTML = `<div data-purchase-ledger="${esc(config.accountId)}">${moduleStatusbar(`${config.title} 매입`, config.purpose, '불러오는 중')}<section class="module-section"><div class="module-section-body"><p class="sales-state">통장 거래와 매입 연결 화면을 불러오고 있습니다.</p></div></section></div>`;
      Promise.resolve().then(() => loadPurchaseLedger(view).then(() => activeView === view && renderPlannedModule(view)));
      return;
    }
    if (purchaseLedgerState.status === 'loading') {
      moduleView.innerHTML = `<div data-purchase-ledger="${esc(config.accountId)}">${moduleStatusbar(`${config.title} 매입`, config.purpose, '불러오는 중')}<section class="module-section"><div class="module-section-body"><p class="sales-state">매입 자료를 불러오고 있습니다.</p></div></section></div>`;
      return;
    }
    if (purchaseLedgerState.status === 'error') {
      moduleView.innerHTML = `<div data-purchase-ledger="${esc(config.accountId)}">${moduleStatusbar(`${config.title} 매입`, config.purpose, '조회 실패')}<section class="module-section"><div class="module-section-body"><p class="sales-state">${esc(purchaseLedgerState.error)}</p><button class="module-action" type="button" data-purchase-refresh>다시 조회</button></div></section></div>`;
      return;
    }
    const account = purchaseLedgerState.account;
    const transactions = purchaseLedgerState.transactions;
    const pagination = purchaseLedgerState.pagination || { page: purchaseLedgerPage, total: transactions.length, totalPages: 1 };
    moduleView.innerHTML = `<div class="purchase-ledger" data-purchase-ledger="${esc(config.accountId)}">
      ${moduleStatusbar(`${config.title} 매입`, `${config.purpose} 내역을 세금계산서와 연결합니다.`, '지정 4계정 전용')}
      ${renderFinancePeriodFilter(view, '통장 거래일 기준')}
      <section class="fund-cards">
        <article class="fund-card"><span>대상 통장</span><strong>${esc(account?.displayName || config.title)}</strong><small>${esc(account?.accountNumberMasked || '계좌정보 확인 중')}</small></article>
        <article class="fund-card strong"><span>최근 잔액</span><strong>${esc(bankMoney(account?.latestBalance))}</strong><small>${esc(account?.latestBalanceAt ? `${bankDate(account.latestBalanceAt)} 기준` : '잔액 수집 전')}</small></article>
        <article class="fund-card warn"><span>조회 거래</span><strong>${Number(pagination.total || 0).toLocaleString('ko-KR')}건</strong><small>${esc(financePeriodLabel())}</small></article>
      </section>
      <section class="module-section">
        <div class="module-section-head"><span><strong>${esc(config.title)} 거래내역</strong><small>향후 수취 세금계산서 API 문서번호와 자동 연결합니다</small></span><button class="module-action" type="button" data-purchase-refresh>새로고침</button></div>
        <div class="module-section-body">
          ${transactions.length ? `<div class="sales-table-scroll"><table class="sales-table purchase-tax-table"><thead><tr><th>거래일시</th><th>구분</th><th>금액</th><th>적요·거래처</th><th>세금계산서</th></tr></thead><tbody>${transactions.map(row => `<tr><td>${esc(bankDate(row.transactionAt))}</td><td><span class="bank-direction ${String(row.direction).toUpperCase() === 'DEPOSIT' ? 'deposit' : 'withdrawal'}">${String(row.direction).toUpperCase() === 'DEPOSIT' ? '입금' : '출금'}</span></td><td>${esc(bankMoney(row.amount, '0원'))}</td><th scope="row">${esc(row.counterpartyName || row.summary || '-')}<span class="request-note">${esc(row.summary || '')}</span></th><td><span class="vendor-chip">API 연결 전</span></td></tr>`).join('')}</tbody></table></div>
          ${Number(pagination.totalPages || 0) > 1 ? `<div class="bank-pagination" aria-label="매입 거래 페이지">
            <button class="module-action" type="button" data-purchase-page="${Math.max(1, purchaseLedgerPage - 1)}" ${purchaseLedgerPage <= 1 ? 'disabled' : ''}>이전</button>
            <span>${purchaseLedgerPage.toLocaleString('ko-KR')} / ${Number(pagination.totalPages).toLocaleString('ko-KR')} 페이지</span>
            <button class="module-action" type="button" data-purchase-page="${Math.min(Number(pagination.totalPages), purchaseLedgerPage + 1)}" ${purchaseLedgerPage >= Number(pagination.totalPages) ? 'disabled' : ''}>다음</button>
          </div>` : ''}` : '<p class="sales-state">선택 기간의 거래내역이 없습니다.</p>'}
        </div>
      </section>
      <div class="module-security"><span>▣</span><span><strong>패션TV봉이 · 박종원 · 김대호 · 손명아만 볼 수 있습니다</strong><br>통장 거래는 읽기 전용이며 세금계산서 원문은 플랫폼 API 또는 권한형 비공개 저장소로만 연결합니다.</span></div>
    </div>`;
  }

  function renderTaxModule() {
    moduleView.innerHTML = `
      ${moduleStatusbar('세금관리 모듈', '거래처별 증빙과 세금계산서를 한 단위로 묶어 관리합니다.')}
      ${renderFinancePeriodFilter('tax', '귀속일 기준 · 실제 세금 데이터 연결 전')}
      <section class="module-grid two">
        ${moduleCard({ icon: '▥', title: '거래처별 사업자등록증', description: '거래처 기본정보와 사업자등록증 원본, 변경 이력 및 유효 상태를 관리합니다.', chip: '민감자료', chipClass: 'restricted', footer: '세무·재무 권한 적용', action: '거래처 보기' })}
        ${moduleCard({ icon: '▤', tone: 'orange', title: '세금계산서', description: '거래처별 발행·수취 세금계산서와 정산 연결 상태를 월별로 확인합니다.', chip: '세무자료', chipClass: 'restricted', footer: '발행·수취 상태 관리', action: '월별 보기' })}
      </section>
      <section class="module-section">
        <div class="module-section-head"><span><strong>거래처 증빙 현황</strong><small>${esc(financePeriodLabel())} · 사업자등록증과 세금계산서를 거래처 기준으로 연결합니다</small></span><span class="module-chip">세금 데이터 연결 전</span></div>
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
    if (view === 'final-settlement') renderFinalSettlementModule();
    if (view === 'final-execution-settlement') renderFinalExecutionSettlementModule();
    if (MONTHLY_TABS[view]) renderMonthlyModule(view);
    if (view === 'ideas') renderIdeaModule();
    if (view === 'requests') renderRequestModule();
    if (view === 'deposit-check') renderDepositModule();
    if (view === 'bank') renderBankModule();
    if (view === 'receivable') renderReceivableModule();
    if (view === 'invoice') renderInvoiceModule();
    if (FINANCE_REQUEST_VIEWS.includes(view)) renderFinanceRequestModule(view);
    if (PURCHASE_TAX_VIEWS.includes(view)) renderPurchaseTaxModule(view);
    if (view === 'credit') renderCreditModule();
    if (view === 'closing') renderClosingModule();
    if (view === 'namecard') renderNamecardModule();
    if (view === 'tax') renderTaxModule();
    if (view === 'platform') renderPlatformModule();
    if (view === 'saas') renderSaasModule();

    moduleView.querySelectorAll('[data-report-type]').forEach(button => button.addEventListener('click', () => {
      reportType = button.dataset.reportType;
      renderPlannedModule('reports');
    }));
    moduleView.querySelector('[data-open-permissions]')?.addEventListener('click', () => activateView('permissions'));
    moduleView.querySelectorAll('[data-vendor-settle]').forEach(button => button.addEventListener('click', () => openVendorDialog(button.dataset.vendorSettle)));

    moduleView.querySelector('[data-final-assign]')?.addEventListener('click', openAssignDialog);
    moduleView.querySelector('[data-cost-fill]')?.addEventListener('click', openCostDialog);
    moduleView.querySelector('[data-price-table]')?.addEventListener('click', openPriceTable);

    // 개인 전용 정산서 등록. 분류 선택은 다시 그리고 글자 입력은 상태만 바꾼다.
    moduleView.querySelectorAll('[data-monthly]').forEach(input => {
      const key = input.dataset.monthly;
      if (input.tagName === 'SELECT') {
        input.addEventListener('change', () => {
          monthlyForm[key] = input.value;
          if (key === 'a') { monthlyForm.b = ''; monthlyForm.c = ''; }
          if (key === 'b') monthlyForm.c = '';
          if (key === 'parentId') {
            const parent = monthlyRows(monthlyForm.view).find(row => row.id === input.value);
            // 실행 건은 판매 건의 업체를 그대로 따른다
            if (parent) monthlyForm.client = parent.client || '';
          }
          renderPlannedModule(monthlyForm.view);
        });
      } else {
        input.addEventListener('input', () => { monthlyForm[key] = input.value; });
      }
    });

    moduleView.querySelectorAll('[data-monthly-run]').forEach(button => button.addEventListener('click', () => {
      const view = activeView;
      const parent = monthlySales(view).find(row => row.id === button.dataset.monthlyRun);
      if (!parent) {
        showToast('연결할 매출을 찾지 못했습니다. 새로고침해 주세요.');
        return;
      }
      monthlyForm = {
        view,
        parentId: parent.id,
        date: localDateKey(new Date()),
        client: parent.client || '',
        a: '', b: '', c: '', qty: '', amount: '', period: '', memo: ''
      };
      renderPlannedModule(view);
      moduleView.querySelector('[data-monthly-form]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    moduleView.querySelector('[data-monthly-sale-mode]')?.addEventListener('click', () => {
      monthlyForm = {
        view: activeView,
        parentId: '',
        date: localDateKey(new Date()),
        client: '',
        a: '', b: '', c: '', qty: '', amount: '', period: '', memo: ''
      };
      renderPlannedModule(activeView);
    });

    moduleView.querySelectorAll('[data-final-execution-filter]').forEach(input => input.addEventListener('change', () => {
      finalExecutionFilter[input.dataset.finalExecutionFilter] = input.value;
      if (finalExecutionFilter.from && finalExecutionFilter.to && finalExecutionFilter.from > finalExecutionFilter.to) {
        if (input.dataset.finalExecutionFilter === 'from') finalExecutionFilter.to = finalExecutionFilter.from;
        else finalExecutionFilter.from = finalExecutionFilter.to;
      }
      renderPlannedModule('final-execution-settlement');
    }));
    moduleView.querySelector('[data-final-execution-reset]')?.addEventListener('click', () => {
      finalExecutionFilter = { from: '', to: '', view: '' };
      renderPlannedModule('final-execution-settlement');
    });
    moduleView.querySelectorAll('[data-final-execution-refresh]').forEach(button => button.addEventListener('click', async () => {
      if (!canSeeFinalExecutionSettlement()) return;
      finalExecutionState = { status: 'loading', rows: [], error: '' };
      renderPlannedModule('final-execution-settlement');
      await loadFinalExecutionSettlement();
      if (activeView === 'final-execution-settlement') renderPlannedModule('final-execution-settlement');
    }));

    moduleView.querySelector('[data-monthly-add]')?.addEventListener('click', async () => {
      const view = monthlyForm.view;
      const form = monthlyForm;
      const amount = Number(form.amount);
      const qty = Number(form.qty) || (form.parentId ? 0 : 1);
      if (!form.client.trim() || !form.a || !form.b || !form.c) {
        showToast('업체명과 분류를 채워 주세요.');
        return;
      }
      if (!Number.isFinite(amount) || amount < 0) {
        showToast(form.parentId ? '실행가를 넣어 주세요.' : '판매가액을 넣어 주세요.');
        return;
      }
      if (!qty || qty < 0) {
        showToast('수량은 1 이상이어야 합니다.');
        return;
      }
      const row = {
        id: `monthly-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        kind: form.parentId ? 'run' : 'sale',
        parentId: form.parentId || '',
        date: form.date || localDateKey(new Date()),
        client: form.client.trim(),
        a: form.a, b: form.b, c: form.c,
        amount, qty,
        period: form.period || '',
        memo: form.memo || ''
      };
      monthlyDraft[view] = monthlyRows(view).concat([row]);
      const saved = await saveMonthlyDraft(view, [row]);
      if (!saved) {
        monthlyDraft[view] = monthlyRows(view).filter(item => item.id !== row.id);
        renderPlannedModule(view);
        return;
      }
      monthlyForm = { ...form, amount: '', qty: '', memo: '', period: '' };
      renderPlannedModule(view);
      showToast(form.parentId ? '실행비를 추가했습니다.' : `${MONTHLY_TABS[view].saleLabel}을 등록했습니다.`);
    });

    // 아이디어 · 개발수정요청 조회
    moduleView.querySelector('[data-idea-category]')?.addEventListener('change', event => {
      ideaCategory = event.target.value;
      renderPlannedModule('ideas');
    });
    moduleView.querySelectorAll('[data-request-status]').forEach(button => button.addEventListener('click', () => {
      requestStatus = button.dataset.requestStatus;
      renderPlannedModule('requests');
    }));

    // 재무·정산 7개 탭이 같은 기간을 공유한다. 통장 응답은 서버 기간 조회라
    // 조건이 바뀔 때 메모리의 이전 응답도 폐기한다.
    const refreshFinancePeriod = () => {
      bankPage = 1;
      resetBankData();
      purchaseLedgerPage = 1;
      purchaseLedgerState = {
        accountId: '', status: 'idle', account: null, transactions: [], error: '',
        pagination: { page: 1, limit: 100, total: 0, totalPages: 0 }
      };
      intakeSelection = [];
      renderPlannedModule(activeView);
    };
    moduleView.querySelectorAll('[data-finance-period-mode]').forEach(button => button.addEventListener('click', () => {
      const mode = button.dataset.financePeriodMode;
      if (!['all', 'month', 'range'].includes(mode)) return;
      financePeriodFilter.mode = mode;
      if (mode === 'month' && !validMonthKey(financePeriodFilter.month)) {
        financePeriodFilter.month = koreaDateKey(new Date()).slice(0, 7);
      }
      if (mode === 'range' && !financePeriodFilter.from && !financePeriodFilter.to) {
        const bounds = monthPeriodBounds(financePeriodFilter.month || koreaDateKey(new Date()).slice(0, 7));
        financePeriodFilter.from = bounds.from;
        financePeriodFilter.to = bounds.to;
      }
      refreshFinancePeriod();
    }));
    moduleView.querySelector('[data-finance-period-month]')?.addEventListener('change', event => {
      const month = validMonthKey(event.target.value);
      if (!month) return;
      financePeriodFilter = { ...financePeriodFilter, mode: 'month', month };
      refreshFinancePeriod();
    });
    const bindFinanceDate = (selector, key) => moduleView.querySelector(selector)?.addEventListener('change', event => {
      financePeriodFilter[key] = validDateKey(event.target.value);
      if (financePeriodFilter.from && financePeriodFilter.to && financePeriodFilter.from > financePeriodFilter.to) {
        if (key === 'from') financePeriodFilter.to = financePeriodFilter.from;
        else financePeriodFilter.from = financePeriodFilter.to;
      }
      financePeriodFilter.mode = 'range';
      refreshFinancePeriod();
    });
    bindFinanceDate('[data-finance-period-from]', 'from');
    bindFinanceDate('[data-finance-period-to]', 'to');

    // 통장 원장은 조회만 새로고침하고, 수집기가 연결된 계좌만 수동 동기화한다.
    const reloadBank = () => {
      resetBankData();
      renderPlannedModule('bank');
    };
    moduleView.querySelector('[data-bank-retry]')?.addEventListener('click', reloadBank);
    moduleView.querySelector('[data-bank-refresh]')?.addEventListener('click', reloadBank);
    moduleView.querySelectorAll('[data-bank-page]').forEach(button => button.addEventListener('click', () => {
      const page = Number(button.dataset.bankPage);
      const totalPages = Number(bankData.pagination?.totalPages || 1);
      if (!Number.isInteger(page) || page < 1 || page > totalPages || page === bankPage) return;
      bankPage = page;
      resetBankData();
      renderPlannedModule('bank');
    }));
    moduleView.querySelector('[data-bank-sync-account]')?.addEventListener('change', event => {
      bankSelectedAccountId = event.target.value;
      const button = moduleView.querySelector('[data-bank-sync]');
      if (button) button.dataset.bankSync = bankSelectedAccountId;
    });
    moduleView.querySelectorAll('[data-bank-sync]').forEach(button => button.addEventListener('click', () => {
      if (!button.disabled) syncBankAccount(button.dataset.bankSync);
    }));

    // 입금체크
    moduleView.querySelectorAll('[data-deposit-filter]').forEach(input => input.addEventListener('change', () => {
      depositFilter[input.dataset.depositFilter] = input.value;
      intakeSelection = [];
      renderPlannedModule('deposit-check');
    }));
    moduleView.querySelectorAll('[data-deposit-client]').forEach(button => button.addEventListener('click', () => {
      depositFilter = { state: '', client: button.dataset.depositClient };
      intakeSelection = [];
      renderPlannedModule('deposit-check');
    }));
    moduleView.querySelectorAll('[data-bank-match-eligibility]').forEach(button => button.addEventListener('click', async () => {
      const eligible = button.dataset.bankMatchNext === 'true';
      if (!confirm(eligible
        ? '예상 입금자명과 미입금액을 확인했고 자동 입금확인 대상으로 확정할까요?'
        : '이 접수를 자동 입금확인 대상에서 해제할까요?')) return;
      button.disabled = true;
      try {
        const result = await callApi(
          'PUT',
          `/peakos/intake/${encodeURIComponent(button.dataset.bankMatchEligibility)}/bank-match-eligibility`,
          {
            eligible,
            reason: eligible
              ? '재무 담당자 자동 입금확인 대상 검토 확정'
              : '재무 담당자 자동 입금확인 대상 검토 해제'
          },
        );
        const apply = row => row.id === result.id
          ? { ...row, bankMatchEligible: result.bankMatchEligible, bankMatchApprovedAt: result.bankMatchApprovedAt }
          : row;
        bankMatchReviewRows = bankMatchReviewRows.map(apply);
        intakeDraft = intakeDraft.map(apply);
        renderPlannedModule('deposit-check');
        showToast(eligible ? '자동 입금확인 대상으로 확정했습니다.' : '자동 입금확인 대상에서 해제했습니다.');
      } catch (error) {
        button.disabled = false;
        showToast(`자동 입금확인 대상을 저장하지 못했습니다. ${error.message}`);
      }
    }));

    // 자금 현황판 — 숫자를 칠 때마다 전체를 다시 그리면 커서가 튀므로
    // 입력은 상태만 바꾸고, 합계는 칸을 벗어날 때 다시 그린다.
    // 값 반영과 다시 그리기를 change 한 곳에서 한다. input 만 믿고 나눠 두면
    // 다시 그리는 사이에 방금 친 값이 날아간다.
    const fundRedraw = () => { saveFundBoard(); renderPlannedModule('receivable'); };
    const fundBind = (selector, apply) => {
      moduleView.querySelectorAll(selector).forEach(input => {
        const handle = () => { apply(input, input.value); saveFundBoard(); fundSync(); };
        input.addEventListener('input', handle);
        input.addEventListener('change', handle);
      });
    };
    fundBind('[data-fund-bank]', (input, value) => { fundBoard.banks[input.dataset.fundBank] = value; });
    fundBind('[data-fund-money]', (input, value) => {
      fundBoard[input.dataset.fundMoney][input.dataset.fundName][input.dataset.fundField] = value;
    });
    fundBind('[data-fund-payroll]', (input, value) => { fundBoard.payroll[input.dataset.fundPayroll] = value; });
    fundBind('[data-fund-label]', (input, value) => { fundBoard[input.dataset.fundLabel] = value; });
    fundBind('[data-fund-vendor]', (input, value) => {
      const row = fundBoard.vendors[Number(input.dataset.fundIndex)];
      if (row) row[input.dataset.fundVendor] = value;
    });
    moduleView.querySelector('[data-fund-vendor-add]')?.addEventListener('click', () => {
      fundBoard.vendors.push({ name: '', total: '', cur: '', prev: '' });
      fundRedraw();
    });
    moduleView.querySelectorAll('[data-fund-vendor-remove]').forEach(button => button.addEventListener('click', () => {
      fundBoard.vendors.splice(Number(button.dataset.fundVendorRemove), 1);
      fundRedraw();
    }));

    // 세금계산서 발행요청
    moduleView.querySelectorAll('[data-invoice-estimate]').forEach(button => button.addEventListener('click', () => {
      const client = button.dataset.invoiceEstimate;
      openEstimateDialog(client, invoiceSourceRows().filter(row => (row.client || '') === client));
    }));

    // 세금계산서·환불·광고비·비품 요청. 입력은 상태에만 두고 제출할 때
    // 서버에서 다시 검증하며 환불계좌 원문은 응답 후 즉시 폼 상태에서 지운다.
    moduleView.querySelectorAll('[data-finance-request]').forEach(input => {
      const key = input.dataset.financeRequest;
      const eventName = input.tagName === 'SELECT' || input.type === 'date' || input.type === 'checkbox' ? 'change' : 'input';
      input.addEventListener(eventName, () => {
        financeRequestForm[key] = input.type === 'checkbox' ? input.checked : input.value;
      });
    });
    moduleView.querySelector('[data-finance-request-submit]')?.addEventListener('click', async event => {
      const view = activeView;
      const config = FINANCE_REQUEST_CONFIG[view];
      const form = currentFinanceRequestForm(view);
      if (!config) return;
      const amountVat = Number(form.amount);
      if (!String(form.client || '').trim() || !String(form.detail || '').trim() || !String(form.memo || '').trim()) {
        showToast('업체명·상세내용·사유를 모두 넣어 주세요.');
        return;
      }
      if (!Number.isSafeInteger(amountVat) || amountVat <= 0) {
        showToast('VAT 포함 금액을 0보다 큰 원 단위 정수로 넣어 주세요.');
        return;
      }
      if (config.requiresEmail && !/^\S+@\S+\.\S+$/.test(String(form.email || '').trim())) {
        showToast('계산서를 받을 이메일을 확인해 주세요.');
        return;
      }
      if (config.requiresBusiness && !financeSafeUrl(form.businessRegistrationUrl)) {
        showToast('접근 권한이 제한된 사업자등록증 링크를 넣어 주세요.');
        return;
      }
      if (config.requiresPayee && [form.payeeBank, form.payeeAccount, form.payeeName].some(value => !String(value || '').trim())) {
        showToast('은행·계좌번호·예금주명을 모두 넣어 주세요.');
        return;
      }
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await callApi('POST', '/peakos/finance-requests', {
          idempotencyKey: form.idempotencyKey,
          kind: config.kind,
          requestDate: form.requestDate || localDateKey(new Date()),
          clientName: String(form.client || '').trim(),
          detail: String(form.detail || '').trim(),
          amountVat,
          businessRegistrationUrl: financeSafeUrl(form.businessRegistrationUrl),
          email: String(form.email || '').trim(),
          payeeBank: String(form.payeeBank || '').trim(),
          payeeAccount: String(form.payeeAccount || '').trim(),
          payeeName: String(form.payeeName || '').trim(),
          reason: String(form.memo || '').trim(),
          invoiceRequested: form.invoiceRequested === true,
          evidenceUrl: financeSafeUrl(form.evidenceUrl),
          sourceAccountId: String(form.sourceAccountId || '').trim()
        });
        financeRequestForm = financeRequestDefault(view);
        await loadFinanceRequests({ quiet: true, view, page: 1 });
        renderPlannedModule(view);
        showToast(`${config.title}을 등록했습니다.`);
      } catch (error) {
        button.disabled = false;
        showToast(`요청을 저장하지 못했습니다. ${error.message}`);
      }
    });
    moduleView.querySelectorAll('[data-finance-request-refresh]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      await loadFinanceRequests({ view: activeView, page: Number(financeRequestState.pagination?.page || 1) });
      if (FINANCE_REQUEST_VIEWS.includes(activeView)) renderPlannedModule(activeView);
    }));
    moduleView.querySelectorAll('[data-finance-request-page]').forEach(button => button.addEventListener('click', async () => {
      const page = Number(button.dataset.financeRequestPage);
      const totalPages = Number(financeRequestState.pagination?.totalPages || 1);
      if (!Number.isInteger(page) || page < 1 || page > totalPages || page === Number(financeRequestState.pagination?.page || 1)) return;
      button.disabled = true;
      await loadFinanceRequests({ view: activeView, page });
      if (FINANCE_REQUEST_VIEWS.includes(activeView)) renderPlannedModule(activeView);
    }));
    moduleView.querySelectorAll('[data-finance-status]').forEach(button => button.addEventListener('click', async () => {
      if (!canReviewFinanceRequests()) return;
      const nextStatus = String(button.dataset.financeStatus || '').toUpperCase();
      let processingNote = '';
      if (nextStatus === 'COMPLETED' && !confirm('이 요청을 처리 완료로 확정할까요? 완료 후에는 되돌릴 수 없습니다.')) return;
      if (nextStatus === 'REJECTED') {
        const reason = prompt('반려 사유를 입력해 주세요. 요청자에게 처리 이력으로 남습니다.', '');
        if (reason === null) return;
        processingNote = String(reason).trim();
        if (!processingNote) {
          showToast('반려 사유를 입력해야 합니다.');
          return;
        }
        if (!confirm('입력한 사유로 이 요청을 반려할까요? 반려 후에는 되돌릴 수 없습니다.')) return;
      }
      button.disabled = true;
      try {
        await callApi('PATCH', `/peakos/finance-requests/${encodeURIComponent(button.dataset.financeId)}`, {
          status: nextStatus,
          ...(processingNote ? { processingNote } : {})
        });
        await loadFinanceRequests({ quiet: true, view: activeView, page: Number(financeRequestState.pagination?.page || 1) });
        renderPlannedModule(activeView);
        showToast('요청 처리 상태를 반영했습니다.');
      } catch (error) {
        button.disabled = false;
        showToast(`처리 상태를 저장하지 못했습니다. ${error.message}`);
      }
    }));
    moduleView.querySelectorAll('[data-finance-cancel]').forEach(button => button.addEventListener('click', async () => {
      if (!confirm('이 요청을 취소할까요? 취소 이력은 장부에 남으며 되돌릴 수 없습니다.')) return;
      button.disabled = true;
      try {
        await callApi('DELETE', `/peakos/finance-requests/${encodeURIComponent(button.dataset.financeCancel)}`);
        await loadFinanceRequests({ quiet: true, view: activeView, page: Number(financeRequestState.pagination?.page || 1) });
        renderPlannedModule(activeView);
        showToast('대기 중인 요청을 취소했습니다.');
      } catch (error) {
        button.disabled = false;
        showToast(`요청을 취소하지 못했습니다. ${error.message}`);
      }
    }));
    moduleView.querySelectorAll('[data-finance-invoice-status]').forEach(button => button.addEventListener('click', async () => {
      if (!canReviewFinanceRequests()) return;
      const nextInvoiceStatus = String(button.dataset.financeInvoiceStatus || '').toUpperCase();
      let evidenceUrl = '';
      if (['ISSUED', 'CORRECTED'].includes(nextInvoiceStatus)) {
        const evidence = prompt('권한이 제한된 계산서 이미지 또는 플랫폼 문서 링크를 입력해 주세요.', '');
        if (evidence === null) return;
        evidenceUrl = financeSafeUrl(evidence);
        if (!evidenceUrl) {
          showToast('HTTPS 계산서 증빙 링크를 입력해야 완료 처리할 수 있습니다.');
          return;
        }
        if (!confirm(nextInvoiceStatus === 'CORRECTED' ? '계산서 정정완료로 확정할까요?' : '계산서 발행완료로 확정할까요?')) return;
      }
      button.disabled = true;
      try {
        await callApi('PATCH', `/peakos/finance-requests/${encodeURIComponent(button.dataset.financeId)}`, {
          invoiceStatus: nextInvoiceStatus,
          ...(evidenceUrl ? { invoiceEvidenceUrl: evidenceUrl } : {})
        });
        await loadFinanceRequests({ quiet: true, view: activeView, page: Number(financeRequestState.pagination?.page || 1) });
        renderPlannedModule(activeView);
        showToast('계산서 처리완료로 반영했습니다.');
      } catch (error) {
        button.disabled = false;
        showToast(`계산서 상태를 저장하지 못했습니다. ${error.message}`);
      }
    }));
    moduleView.querySelectorAll('[data-purchase-refresh]').forEach(button => button.addEventListener('click', () => {
      purchaseLedgerState = {
        accountId: '', status: 'idle', account: null, transactions: [], error: '',
        pagination: { page: purchaseLedgerPage, limit: 100, total: 0, totalPages: 0 }
      };
      renderPlannedModule(activeView);
    }));
    moduleView.querySelectorAll('[data-purchase-page]').forEach(button => button.addEventListener('click', () => {
      const page = Number(button.dataset.purchasePage);
      const totalPages = Number(purchaseLedgerState.pagination?.totalPages || 1);
      if (!Number.isInteger(page) || page < 1 || page > totalPages || page === purchaseLedgerPage) return;
      purchaseLedgerPage = page;
      purchaseLedgerState = {
        accountId: '', status: 'idle', account: null, transactions: [], error: '',
        pagination: { page, limit: 100, total: 0, totalPages }
      };
      renderPlannedModule(activeView);
    }));

    // 충전금
    moduleView.querySelectorAll('[data-credit-request]').forEach(input => {
      const key = input.dataset.creditRequest;
      const eventName = input.tagName === 'SELECT' || input.type === 'date' ? 'change' : 'input';
      input.addEventListener(eventName, () => { creditRequestForm[key] = input.value; });
    });
    moduleView.querySelector('[data-credit-request-submit]')?.addEventListener('click', async event => {
      const form = creditRequestForm;
      const requiredText = [form.client, form.depositorName, form.product, form.vendor];
      if (requiredText.some(value => !String(value || '').trim())) {
        showToast('업체명, 실제 입금자명, 상품, 공급처를 모두 넣어 주세요.');
        return;
      }
      const expectedAmount = Number(form.expectedAmount);
      const pointAmount = Number(form.pointAmount);
      if (!Number.isSafeInteger(expectedAmount) || expectedAmount <= 0
        || !Number.isSafeInteger(pointAmount) || pointAmount <= 0) {
        showToast('예상 입금액과 승인할 충전금을 0보다 큰 원 단위 정수로 넣어 주세요.');
        return;
      }
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await callApi('POST', '/peakos/credit-requests', {
          targetAccountId: form.targetAccountId,
          requestDate: form.requestDate || localDateKey(new Date()),
          client: form.client.trim(),
          depositorName: form.depositorName.trim(),
          product: form.product.trim(),
          vendor: form.vendor.trim(),
          expectedAmount,
          pointAmount,
          memo: form.memo.trim()
        });
        creditRequestForm = {
          ...form,
          requestDate: form.requestDate || localDateKey(new Date()),
          client: '', depositorName: '', expectedAmount: '', pointAmount: '', memo: ''
        };
        await loadCreditDraft();
        renderPlannedModule('credit');
        showToast('충전 요청을 등록했습니다. 정확한 입금이 확인되면 자동 승인됩니다.');
      } catch (error) {
        button.disabled = false;
        showToast(`충전 요청을 저장하지 못했습니다. ${error.message}`);
      }
    });
    moduleView.querySelectorAll('[data-credit-request-cancel]').forEach(button => button.addEventListener('click', async () => {
      if (!confirm('입금 대기 중인 충전 요청을 취소할까요?')) return;
      button.disabled = true;
      try {
        await callApi('DELETE', `/peakos/credit-requests/${encodeURIComponent(button.dataset.creditRequestCancel)}`);
        await loadCreditDraft();
        renderPlannedModule('credit');
        showToast('충전 요청을 취소했습니다.');
      } catch (error) {
        button.disabled = false;
        showToast(`충전 요청을 취소하지 못했습니다. ${error.message}`);
      }
    }));
    moduleView.querySelectorAll('[data-credit-kind]').forEach(button => button.addEventListener('click', () => {
      creditForm.kind = button.dataset.creditKind;
      renderPlannedModule('credit');
    }));
    moduleView.querySelectorAll('[data-credit]').forEach(input => {
      const key = input.dataset.credit;
      const handler = () => { creditForm[key] = input.value; };
      if (input.tagName === 'SELECT') {
        input.addEventListener('change', () => { handler(); renderPlannedModule('credit'); });
      } else {
        input.addEventListener('input', handler);
      }
    });
    moduleView.querySelector('[data-credit-add]')?.addEventListener('click', () => {
      const form = creditForm;
      if (!form.client.trim()) {
        showToast('업체명을 넣어 주세요.');
        return;
      }
      const paid = Number(form.paid) || 0;
      const point = Number(form.point) || 0;
      if (!paid && !point) {
        showToast('입금액이나 충전 포인트 중 하나는 넣어야 합니다.');
        return;
      }
      creditDraft.push({
        id: `credit-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        date: form.date || localDateKey(new Date()),
        client: form.client.trim(),
        product: form.product || '',
        vendor: form.vendor || '',
        kind: form.kind || 'charge',
        paid, point,
        memo: form.memo || ''
      });
      saveCreditDraft();
      creditForm = { ...form, client: '', paid: '', point: '', memo: '' };
      renderPlannedModule('credit');
      showToast(`${CREDIT_KINDS[form.kind]} 내역을 기입했습니다.`);
    });
    moduleView.querySelectorAll('[data-credit-remove]').forEach(button => button.addEventListener('click', async () => {
      const id = button.dataset.creditRemove;
      button.disabled = true;
      try {
        await callApi('DELETE', `/peakos/credit/${encodeURIComponent(id)}`);
        creditDraft = creditDraft.filter(row => row.id !== id);
        renderPlannedModule('credit');
      } catch (error) {
        button.disabled = false;
        showToast(`충전금 장부를 지우지 못했습니다. ${error.message}`);
      }
    }));

    // 명함 — 글자를 칠 때마다 한 장짜리 미리보기만 다시 그린다
    moduleView.querySelectorAll('[data-card]').forEach(input => input.addEventListener('input', () => {
      namecardForm[input.dataset.card] = input.value;
      drawNamecard(namecardForm);
    }));
    moduleView.querySelectorAll('[data-card-download]').forEach(button => button.addEventListener('click', () => {
      const canvas = document.getElementById('namecardCanvas');
      if (!canvas) return;
      canvas.toBlob(blob => {
        if (!blob) {
          showToast('이미지를 만들지 못했습니다.');
          return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        const safeName = safeNamecardFilename(namecardForm.name);
        link.download = `명함_${safeName}.png`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast('한 장짜리 명함 이미지를 저장했습니다.');
      }, 'image/png');
    }));

    moduleView.querySelectorAll('[data-monthly-remove]').forEach(button => button.addEventListener('click', async () => {
      const view = monthlyForm.view;
      const id = button.dataset.monthlyRemove;
      // 판매 건을 지우면 거기 붙은 실행 건도 같이 사라진다
      const removed = await removeMonthlyRow(view, id);
      if (!removed) return;
      monthlyDraft[view] = monthlyRows(view).filter(row => row.id !== id && row.parentId !== id);
      if (monthlyForm.parentId === id) {
        monthlyForm = { ...monthlyForm, parentId: '', client: '', amount: '', qty: '', memo: '', period: '' };
      }
      renderPlannedModule(view);
    }));
    // 접수 없이 받을 돈이 생기기도 해서 빈 정산서로도 시작한다.
    moduleView.querySelector('[data-estimate-new]')?.addEventListener('click', () => openEstimateDialog('', []));
    moduleView.querySelector('[data-estimate-open]')?.addEventListener('click', () => {
      // 거래처를 골라 뒀으면 그 업체로, 아니면 첫 업체로 연다.
      const clients = [...new Set(filteredIntake().map(row => row.client).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
      if (!clients.length) {
        showToast('정산서를 낼 접수가 아직 없습니다.');
        return;
      }
      const client = clients.includes(intakeFilter.client) ? intakeFilter.client : clients[0];
      openEstimateDialog(client, filteredIntake().filter(row => (row.client || '') === client));
    });
    moduleView.querySelector('[data-intake-toggle]')?.addEventListener('click', () => {
      intakeOpen = !intakeOpen;
      renderPlannedModule(intakeContext);
    });

    moduleView.querySelectorAll('[data-final-filter]').forEach(input => input.addEventListener('change', () => {
      finalFilter[input.dataset.finalFilter] = input.value;
      renderPlannedModule('final-settlement');
    }));
    moduleView.querySelector('[data-final-filter-reset]')?.addEventListener('click', () => {
      finalFilter = { from: '', to: '', manager: '' };
      renderPlannedModule('final-settlement');
    });

    moduleView.querySelectorAll('[data-intake]').forEach(input => {
      const key = input.dataset.intake;
      if (input.tagName === 'SELECT') {
        // 분류나 대상 건을 바꾸면 선택지와 상한을 다시 잡아야 하므로 전체를 그린다
        input.addEventListener('change', () => {
          intakeForm[key] = input.value;
          if (key === 'a') { intakeForm.b = ''; intakeForm.c = ''; intakeForm.unit = ''; }
          if (key === 'b') { intakeForm.c = ''; intakeForm.unit = ''; }
          if (key === 'c') intakeForm.unit = '';
          renderPlannedModule(intakeContext);
        });
        return;
      }
      // 글자 입력은 상태와 계산 칸만 갱신한다. 다시 그리면 커서가 튄다.
      input.addEventListener('input', () => {
        intakeForm[key] = input.value;
        updateIntakeCalc();
      });
    });

    moduleView.querySelectorAll('[data-intake-kind]').forEach(button => button.addEventListener('click', () => {
      intakeForm.kind = button.dataset.intakeKind;
      intakeForm.refOf = '';
      renderPlannedModule(intakeContext);
    }));

    moduleView.querySelectorAll('[data-ledger-filter]').forEach(input => {
      input.addEventListener('change', () => {
        intakeFilter[input.dataset.ledgerFilter] = input.value;
        intakeSelection = [];
        renderPlannedModule(intakeContext);
      });
    });
    moduleView.querySelector('[data-ledger-filter-reset]')?.addEventListener('click', () => {
      intakeFilter = { client: '', product: '', paid: '' };
      intakeSelection = [];
      renderPlannedModule(intakeContext);
    });

    moduleView.querySelectorAll('[data-paid-open]').forEach(button => button.addEventListener('click', () => {
      const rowId = button.dataset.paidOpen;
      // 묶음 처리는 위 선택 바의 전용 버튼으로만 실행한다. 선택하지 않은
      // 행의 입금 버튼을 눌렀다면 그 한 건만 열어 오처리를 막는다.
      const picked = intakeSelection.includes(rowId) ? intakeSelection : [rowId];
      openPaidDialog(picked);
    }));

    moduleView.querySelectorAll('[data-intake-pick]').forEach(box => box.addEventListener('change', () => {
      const id = box.dataset.intakePick;
      intakeSelection = box.checked
        ? [...new Set([...intakeSelection, id])]
        : intakeSelection.filter(item => item !== id);
      refreshPickBar();
    }));
    refreshPickBar();

    moduleView.querySelectorAll('[data-team-member]').forEach(button => button.addEventListener('click', () => {
      showToast(`${button.dataset.teamMember} 님 정산서는 접수를 서버에 저장한 뒤에 열립니다.`);
    }));

    moduleView.querySelector('[data-intake-add]')?.addEventListener('click', () => {
      const form = intakeForm;
      const row = priceRow(form.a, form.b, form.c);
      const unit = Number(row && row[4] !== null ? row[4] : form.unit) || 0;
      const qty = Number(form.qty) || 0;
      const sell = Number(form.sell) || 0;
      if (!row || !qty || !unit) {
        showToast('상품·수량·단가를 채워 주세요.');
        return;
      }
      if (!Number.isFinite(qty)) {
        showToast('수량을 숫자로 넣어 주세요.');
        return;
      }
      // 당일접수·예약건 작업은 음수로 되돌릴 수 있다. 공급사 정산에서도
      // 원가를 같이 빼야 하기 때문이다. 예약최초건과 환불은 뜻이 뒤집히므로 막는다.
      if (qty < 0 && (form.kind === 'reserve' || form.kind === 'refund')) {
        showToast(form.kind === 'reserve'
          ? '예약최초건은 수량을 1 이상으로 넣어 주세요.'
          : '환불은 수량을 1 이상으로 넣으면 자동으로 마이너스가 됩니다.');
        return;
      }

      // 예약 차감과 환불은 원래 건을 넘을 수 없다.
      if (form.kind === 'use' || form.kind === 'refund') {
        const target = intakeDraft.find(item => item.id === form.refOf);
        if (!target) {
          showToast(form.kind === 'use' ? '차감할 예약최초건을 골라 주세요.' : '환불할 접수건을 골라 주세요.');
          return;
        }
        if (form.kind === 'use') {
          if (paidStateOf(target) !== 'paid') {
            showToast('예약최초건의 입금이 확인되어야 예약건 작업을 등록할 수 있습니다.');
            return;
          }
          if (reserveKey({ client: form.client, memo: form.memo }) !== reserveKey(target)) {
            showToast('업체명과 메모가 예약최초건과 같아야 차감할 수 있습니다.');
            return;
          }
          if (Number(form.sell) !== Number(target.sell)) {
            showToast('판매 단가는 예약최초건과 같아야 합니다.');
            return;
          }
          // 되돌림은 실제로 쓴 수량까지만. 그래야 잔여가 원 예약을 못 넘는다.
          if (qty < 0) {
            const used = reserveUsed(target.id);
            if (used.qty + qty < 0) {
              showToast(`되돌릴 수 있는 수량은 ${used.qty}개까지입니다.`);
              return;
            }
          }
          const left = reserveRemaining(target);
          if (qty > left.qty) {
            showToast(`예약 잔여 수량 ${left.qty}개를 넘을 수 없습니다.`);
            return;
          }
          if (sell * qty > left.amount) {
            showToast(`예약 잔여 금액 ${left.amount.toLocaleString('ko-KR')}원을 넘을 수 없습니다.`);
            return;
          }
        } else {
          const left = refundableQty(target);
          if (qty > left) {
            showToast(`환불 가능 수량 ${left}개를 넘을 수 없습니다.`);
            return;
          }
        }
      }
      intakeDraft.push({
        id: `intake-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        date: form.date || localDateKey(new Date()),
        client: form.client || '',
        expectedPayer: String(form.expectedPayer || form.client || '').trim(),
        a: form.a, b: form.b, c: form.c,
        unit, qty, sell,
        memo: form.memo || '',
        kind: form.kind || 'normal',
        refOf: form.refOf || '',
        // 상시변동 상품은 단가표에 원가가 없어 직접 넣은 값을 쓴다.
        cost: row[3] === null ? (form.cost === '' || form.cost === undefined ? null : Number(form.cost)) : row[3],
        supplier: form.supplier || defaultSupplier(form.b, form.c) || '',
        manager: form.manager || '',
        // 최종정산서에서 넣은 건은 개인정산서에 올리지 않는다.
        finalOnly: intakeContext === 'final-settlement',
        owner: userDoc?.uid || '',
        ownerName: userDoc?.name || '',
        // 공급사 정산 — 공급처에 우리가 지불하는 쪽. 거래처 입금과 별개다.
        vendorPaid: false,
        vendorPaidDate: '',
        vendorBank: '',
        vendorBy: '',
        vendorMemo: '',
        // 입금 확인 정보. 정확한 금액·입금자명 1건만 서버에서 자동 확인한다.
        paid: 'none',
        paidAmount: 0,
        payer: '',
        paidDate: '',
        paidMemo: '',
        paidAuto: false
      });
      if (previewPersona) {
        showToast(`${previewPersona} 계정 미리보기 중에는 등록되지 않습니다.`);
        intakeDraft.pop();
        return;
      }
      saveIntakeDraft();
      intakeForm = { ...form, client: '', expectedPayer: '', qty: '', sell: '', memo: '', unit: '', refOf: '', supplier: '', cost: '' };
      renderPlannedModule(intakeContext);
      showToast(intakeContext === 'final-settlement'
        ? '최종정산서에만 올라가는 건으로 등록했습니다.'
        : '접수를 등록했습니다. 이 브라우저에만 저장되는 초안입니다.');
    });

    moduleView.querySelectorAll('[data-intake-remove]').forEach(button => button.addEventListener('click', async () => {
      // 미리보기 중에는 화면에서도 지우지 않는다. 저장되지 않는데 사라지면 오해를 준다.
      if (previewPersona) {
        showToast(`${previewPersona} 계정 미리보기 중에는 지울 수 없습니다.`);
        return;
      }
      const id = button.dataset.intakeRemove;
      intakeDraft = intakeDraft.filter(row => row.id !== id);
      bankMatchReviewRows = bankMatchReviewRows.filter(row => row.id !== id);
      renderPlannedModule(intakeContext);
      await removeIntakeRow(id);
    }));

    moduleView.querySelector('[data-org-edit-toggle]')?.addEventListener('click', () => {
      orgEditMode = !orgEditMode;
      renderPlannedModule('organization');
    });
    moduleView.querySelector('[data-org-branch-filter]')?.addEventListener('change', event => {
      orgBranchFilter = event.target.value;
      renderPlannedModule('organization');
    });
    moduleView.querySelectorAll('[data-org-rank]').forEach(select => select.addEventListener('change', event => {
      const name = select.dataset.orgRank;
      const rank = event.target.value;
      if (rank === ORG_RANK_UNSET) delete orgRankDraft[name];
      else orgRankDraft[name] = rank;
      saveOrgRankDraft();
      renderPlannedModule('organization');
      showToast(`${name} 직급을 ${rank}(으)로 바꿨습니다. 이 브라우저에만 저장되는 초안입니다.`);
    }));

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

  function setNavSubclusterClosed(subcluster, closed) {
    if (!subcluster) return;
    subcluster.classList.toggle('closed', closed);
    const toggle = subcluster.querySelector('.nav-subcluster-toggle');
    const caret = subcluster.querySelector('.nav-subcluster-caret');
    if (toggle) toggle.setAttribute('aria-expanded', closed ? 'false' : 'true');
    if (caret) caret.textContent = closed ? '⌄' : '⌃';
  }

  function activateView(view) {
    // 자금 현황판을 떠나기 전에 못 보낸 값을 밀어 넣는다.
    if (activeView === 'receivable' && view !== 'receivable') flushFundBoard();
    // 상위 메뉴 권한이 있더라도 지정되지 않은 개인 전용 정산서로는 들어가지 못한다.
    if (MONTHLY_TABS[view] && !canSeeMonthly(view)) {
      showToast('이 정산서의 열람 권한이 없습니다.');
      view = canSeeSalesOperations() ? 'settlement' : 'dashboard';
    }
    // 아직 공개하지 않은 화면은 주소로 들어와도 막는다.
    const creditRequestAllowed = view === 'credit' && !previewPersona;
    const salesOperationAllowed = SALES_OPERATION_VIEWS.includes(view) && canSeeSalesOperations();
    const specialSettlementAllowed = Boolean(MONTHLY_TABS[view]) && canSeeMonthly(view);
    const taxBankingAllowed = canSeeTaxBankingView(view);
    if (!canSeePeakosTabs() && !LIVE_PARAGON_VIEWS.includes(view)
      && view !== 'permissions' && !creditRequestAllowed && !salesOperationAllowed
      && !specialSettlementAllowed && !taxBankingAllowed) {
      view = 'dashboard';
    }
    if ((TAX_BANKING_PUBLIC_VIEWS.includes(view) || PURCHASE_TAX_VIEWS.includes(view))
      && !canSeeTaxBankingView(view)) {
      view = previewPersona ? 'calendar' : 'dashboard';
    }
    if (view === 'final-execution-settlement' && !canSeeFinalExecutionSettlement()) {
      view = canSeeSalesOperations() ? 'settlement' : 'dashboard';
    }
    // 미리보기 중 채팅은 어느 경로로도 열지 않는다.
    if (previewPersona && view === 'chat') {
      showToast('계정 미리보기 중에는 채팅을 볼 수 없습니다.');
      view = 'calendar';
    }
    // 체크 선택은 현재 화면에서만 유효하다. 다른 탭의 숨겨진 접수가
    // 묶음 입금 처리에 섞이지 않도록 화면을 떠날 때 반드시 비운다.
    if (view !== activeView) intakeSelection = [];
    activeView = view;
    if (view !== 'chat') closeChatRoom();
    body.classList.toggle('calendar-workspace', view === 'calendar');
    // 조직도는 넓은 화면을 다 써야 트리가 스크롤 없이 들어간다
    body.classList.toggle('org-workspace', view === 'organization');
    // 정산은 접수 칸이 한 줄에 들어가야 해서 전체 폭을 쓴다
    body.classList.toggle('settlement-workspace', view === 'settlement' || view === 'final-settlement');
    const isPlannedModule = Object.prototype.hasOwnProperty.call(PLANNED_MODULES, view);
    if (isPlannedModule) renderPlannedModule(view);
    if (view === 'review') renderProjects();
    dashboardView.hidden = view !== 'dashboard';
    calendarView.hidden = view !== 'calendar';
    chatView.hidden = view !== 'chat';
    todoView.hidden = view !== 'todo';
    reviewView.hidden = view !== 'review';
    moduleView.hidden = !isPlannedModule;
    permissionsView.hidden = view !== 'permissions';
    const labels = { dashboard: '피크마케팅', calendar: '캘린더', chat: '채팅', todo: '할 일', review: '프로젝트', permissions: '조직 및 권한', ...PLANNED_MODULES };
    pageCrumb.textContent = labels[view] || '피크마케팅';
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
    const activeNav = document.querySelector(`.app-sidebar .nav-item[data-view="${view}"]`);
    if (activeNav) {
      setNavClusterClosed(activeNav.closest('[data-nav-cluster]'), false);
      setNavSubclusterClosed(activeNav.closest('[data-nav-subcluster]'), false);
    }
    body.classList.remove('menu-open');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function wireNavigation() {
    let orgFitTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(orgFitTimer);
      orgFitTimer = setTimeout(fitOrgTrees, 120);
    });
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
    document.querySelectorAll('[data-nav-subcluster]').forEach(subcluster => {
      subcluster.querySelector('.nav-subcluster-toggle')?.addEventListener('click', () => {
        setNavSubclusterClosed(subcluster, !subcluster.classList.contains('closed'));
      });
    });

    const search = document.getElementById('sidebarTabSearch');
    const submit = document.getElementById('sidebarTabSearchSubmit');
    const searchable = [...document.querySelectorAll('.nav-section .nav-item[data-tab-search]')];
    const navClusters = [...document.querySelectorAll('[data-nav-cluster]')];
    const navSubclusters = [...document.querySelectorAll('[data-nav-subcluster]')];
    const filter = () => {
      const query = search.value.trim().toLowerCase().replace(/\s/g, '');
      let visible = 0;
      searchable.forEach(button => {
        const locked = button.dataset.navLocked === 'true';
        const matches = !locked && (!query || button.dataset.tabSearch.toLowerCase().replace(/\s/g, '').includes(query));
        button.hidden = !matches;
        if (matches) visible += 1;
      });
      navClusters.forEach(cluster => {
        const hasVisibleItem = [...cluster.querySelectorAll('.nav-item[data-tab-search]')].some(button => !button.hidden);
        cluster.hidden = !!query && !hasVisibleItem;
        cluster.classList.toggle('search-open', !!query && hasVisibleItem);
      });
      navSubclusters.forEach(subcluster => {
        const hasVisibleItem = [...subcluster.querySelectorAll('.nav-item[data-tab-search]')].some(button => !button.hidden);
        subcluster.hidden = !hasVisibleItem;
        subcluster.classList.toggle('search-open', !!query && hasVisibleItem);
        if (query && hasVisibleItem) setNavSubclusterClosed(subcluster, false);
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
    activateView('calendar');
  }

  async function finishSignedInApp() {
    const loadUid = currentUser?.uid || '';
    if (!loadUid) throw new Error('로그인이 필요합니다.');
    if (signedInLoadPromise && signedInLoadUid === loadUid) return signedInLoadPromise;
    const accessGeneration = osAuthAccessGeneration;
    signedInLoadUid = loadUid;
    const loadPromise = (async () => {
      await loadPeakosData();
      await loadLiveData();
      if (!currentUser
        || currentUser.uid !== loadUid
        || accessGeneration !== osAuthAccessGeneration
        || (isOsRoute() && osAuthExpired)) {
        throw new Error('추가 인증 세션이 만료되었습니다.');
      }

      // 데이터 로딩 중 다른 탭에서 로그아웃·재인증이 일어날 수 있다.
      // 민감한 화면을 실제로 열기 직전에 서버 세션을 마지막으로 확인한다.
      if (isOsRoute()) {
        let finalSession;
        try {
          finalSession = await readOnlyApi('/os-auth/session');
        } catch (error) {
          if (error.status === 401
            && ['OS_AUTH_SESSION_REQUIRED', 'OS_AUTH_SESSION_INVALID'].includes(error.code)) {
            finalSession = error.payload || { required: true, verified: false };
          } else {
            throw error;
          }
        }
        if (finalSession?.required !== false && !hasOsAuthSession(finalSession)) {
          if (!osAuthExpired) osAuthAccessGeneration += 1;
          osAuthExpired = true;
          clearOsSessionExpiryTimer();
          throw new Error('추가 인증 세션이 만료되었습니다.');
        }
        if (finalSession.required === true) scheduleOsSessionExpiry(finalSession?.expiresInSeconds);
        else clearOsSessionExpiryTimer();
      }
      if (!currentUser
        || currentUser.uid !== loadUid
        || accessGeneration !== osAuthAccessGeneration
        || (isOsRoute() && osAuthExpired)) {
        throw new Error('추가 인증 세션이 만료되었습니다.');
      }
      renderAllLiveViews();
      if (!currentUser
        || currentUser.uid !== loadUid
        || accessGeneration !== osAuthAccessGeneration
        || (isOsRoute() && osAuthExpired)) {
        throw new Error('추가 인증 세션이 만료되었습니다.');
      }
      clearOsAuthTimer();
      document.getElementById('authGate').hidden = true;
      showToast('기존 파라곤 운영 데이터를 읽기 전용으로 불러왔습니다.');
    })();
    signedInLoadPromise = loadPromise;
    try {
      await loadPromise;
    } catch (error) {
      if (signedInLoadPromise === loadPromise) {
        signedInLoadPromise = null;
        signedInLoadUid = '';
      }
      throw error;
    }
  }

  async function handleSignedIn(user) {
    const handledUid = user.uid;
    osAuthForceAccountChooser = false;
    currentUser = user;
    const button = document.getElementById('googleSignIn');
    if (button) button.disabled = true;
    setAuthStatus('계정 권한과 운영 데이터를 확인하고 있습니다…');
    try {
      const loadedUserDoc = await readOnlyApi('/users/me');
      if (!currentUser || currentUser.uid !== handledUid) return;
      userDoc = loadedUserDoc;
      realUserDoc = userDoc;
      if (userDoc.is_active === false) throw new Error('비활성화된 계정입니다. 관리자에게 문의해 주세요.');
      if (!userDoc.approved) throw new Error('아직 승인되지 않은 계정입니다.');

      if (isOsRoute()) {
        let session;
        const sessionCheckGeneration = ++osAuthSessionCheckGeneration;
        try {
          session = await readOnlyApi('/os-auth/session');
        } catch (sessionError) {
          if (sessionError.status === 401
            && ['OS_AUTH_SESSION_REQUIRED', 'OS_AUTH_SESSION_INVALID'].includes(sessionError.code)) {
            session = sessionError.payload || { required: true, verified: false };
          } else {
            throw sessionError;
          }
        }
        if (!currentUser
          || currentUser.uid !== handledUid
          || sessionCheckGeneration !== osAuthSessionCheckGeneration) return;
        if (session?.required !== true && session?.required !== false) {
          throw new Error('PEAK OS 추가 인증 상태를 확인하지 못했습니다. 새로고침해 주세요.');
        }
        osAuthMaskedEmail = String(session?.user?.maskedEmail || session?.maskedEmail || '');
        if (session.required === true && !hasOsAuthSession(session)) {
          if (!osAuthExpired) osAuthAccessGeneration += 1;
          osAuthExpired = true;
          moveToOsLogin();
          renderOsEmailGate({ message: osLoginReasonMessage() });
          return;
        }
        if (osAuthExpired) osAuthAccessGeneration += 1;
        osAuthExpired = false;
        osAuthHardNavigating = false;
        if (session.required === true) scheduleOsSessionExpiry(session?.expiresInSeconds);
        else clearOsSessionExpiryTimer();
        if (isOsLoginRoute()) moveToOsDestination();
      }

      if (!currentUser || currentUser.uid !== handledUid) return;
      await finishSignedInApp();
    } catch (error) {
      if (osAuthHardNavigating || !currentUser || currentUser.uid !== handledUid) return;
      if (button) button.disabled = false;
      if (error.status === 404) {
        if (isOsRoute()) renderOsGoogleGate();
        setAuthStatus('기존 파라곤에 등록된 계정이 아닙니다. 먼저 운영 사이트에서 계정 승인을 받아 주세요.', true);
      } else {
        if (isOsRoute() && userDoc) renderOsEmailGate({ message: error.message || '인증 상태를 확인하지 못했습니다.', isError: true });
        setAuthStatus(error.message || '운영 데이터를 불러오지 못했습니다.', true);
      }
    }
  }

  function initialize() {
    loadOrgRankDraft();
    createAuthGate();
    createDetailModal();
    wireNavigation();
    if (!window.firebase) {
      setAuthStatus('로그인 모듈을 불러오지 못했습니다. 새로고침해 주세요.', true);
      return;
    }
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    initializeOsAuthTabSync();
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    auth.getRedirectResult().catch(error => setAuthStatus(`로그인 실패: ${error.message}`, true));
    auth.onAuthStateChanged(user => {
      if (!user) {
        osAuthSessionCheckGeneration += 1;
        osAuthAccessGeneration += 1;
        closeDetailModal({ restoreFocus: false });
        resetCompanyDocumentState();
        clearOsAuthTimer();
        clearOsSessionExpiryTimer();
        currentUser = null;
        userDoc = null;
        realUserDoc = null;
        signedInLoadPromise = null;
        signedInLoadUid = '';
        osAuthSyncPromise = null;
        osAuthSyncQueuedForce = false;
        osAuthChallengeId = '';
        osAuthMaskedEmail = '';
        osAuthExpired = false;
        osAuthHardNavigating = false;
        document.getElementById('authGate').hidden = false;
        if (isOsRoute()) {
          renderOsGoogleGate();
        } else {
          renderLegacyGoogleGate();
          setAuthStatus('등록·수정·삭제는 이 화면에서 실행되지 않습니다.');
        }
        return;
      }
      if (currentUser && currentUser.uid !== user.uid) {
        osAuthSessionCheckGeneration += 1;
        osAuthAccessGeneration += 1;
        closeDetailModal({ restoreFocus: false });
        resetCompanyDocumentState();
        clearOsSessionExpiryTimer();
        signedInLoadPromise = null;
        signedInLoadUid = '';
        osAuthSyncPromise = null;
        osAuthSyncQueuedForce = false;
        userDoc = null;
        realUserDoc = null;
        resetBankData({ clearOperation: true });
      }
      handleSignedIn(user);
    });
  }

  initialize();
})();
