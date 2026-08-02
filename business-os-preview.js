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
  let activeView = 'dashboard';
  // 시트접수 건. 아직 운영 DB에 쓰지 않고 브라우저에만 남는 초안이다.
  let intakeDraft = [];
  let intakeForm = { a: '', b: '', c: '', unit: '', qty: '', sell: '', client: '', date: '', memo: '', kind: 'normal', refOf: '' };
  let intakeFilter = { from: '', to: '', client: '', product: '', paid: '' };
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
    settlement: '정산서',
    'final-settlement': '최종정산서',
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
  const PRICE_TABLE = [
    ['플레이스', '상위노출', '월보장', null, null],
    ['플레이스', '상위노출', '건바이', null, null],
    ['지식인', '상위노출', '월보장', null, null],
    ['지식인', '상위노출', '건바이', null, null],
    ['지식인', '배포', '단순배포', 3000, 3500],
    ['자동완성', '자동완성', '월보장', 45000, 47000],
    ['자동완성', '자동완성', '슬롯', 13000, 15000],
    ['웹사이트', '웹사이트', '슬롯', 40000, 45000],
    ['SNS', '영상제작', '영상제작', 70000, 75000],
    ['상세페이지', '상세페이지 제작', '1000PX', 10000, 10000],
    ['유튜브', '자동완성', '월보장', null, null],
    ['유튜브', '자동완성', '슬롯', 35000, 35000],
    ['유튜브', '상위노출', '월보장', null, null],
    ['유튜브', '상위노출', '건바이', null, null],
    ['리워드', '신규리워드', '트래픽', 20, 22],
    ['리워드', 'Alpha', '트래픽', 21, 24],
    ['리워드', '올데이', '트래픽', 21, 23],
    ['리워드', '올데이 (쇼핑)', '트래픽', 18, 20],
    ['리워드', '프리저', '트래픽', 18, 20],
    ['리워드', '프리저', '저장하기', 27, 29],
    ['리워드', '프리저', '스마트콜', 26, 28],
    ['리워드', '파라곤 (쇼핑)', '트래픽', 22, 24],
    ['리워드', '피크리워드', '트래픽', 18, 20],
    ['리워드', '피크리워드', '저장하기', 27, 29],
    ['리워드', '프리저 (쇼핑)', '트래픽', 19, 21],
    ['리워드', 'BOOSTER', '트래픽', 32, 34],
    ['리워드', 'BOOSTER Pro', '트래픽', 35, 35],
    ['리워드', '포미션', '트래픽', 20, 22],
    ['리워드', '포미션', '저장하기', 30, 32],
    ['리워드', '포미션', '대행사 페이백', null, null],
    ['리워드', '포미션', '찜', 50, 52],
    ['리워드', '파라곤', '트래픽', 35, 36],
    ['블로그', 'P01', '사진 1장', 300, 400],
    ['블로그', 'P01', '사진 1장 247', 400, 500],
    ['블로그', 'P01', '사진 3장', 400, 500],
    ['블로그', 'P01', '사진 3장 247', 500, 600],
    ['블로그', 'P01', 'AI 사진 3장 ', 400, 500],
    ['블로그', 'P01', '유입형 사진 3장 247', 1150, 1200],
    ['블로그', 'P01', '개별세팅옵션', 200, 200],
    ['블로그', 'P01-A', '사진 3장 글자수 100~300', 700, 800],
    ['블로그', 'P01-A', '사진 5장 글자수 300~500', 1100, 1200],
    ['블로그', 'P01-A', '사진 10장 글자수 600~900', 1700, 1800],
    ['블로그', 'P01-A', '사진 15장 글자수 1000~1200', 2500, 2500],
    ['블로그', 'P01-A', '개별세팅옵션', 200, 200],
    ['블로그', 'P01-A', '24옵션', 100, 100],
    ['블로그', 'P01-A', '준최 3', 6000, 6500],
    ['블로그', 'P02', '일반~준최5 이미지 7장 700', 1000, 1000],
    ['블로그', 'P02', '준최2~준최5 이미지 5장 500', 1100, 1100],
    ['블로그', 'P02', '준최2~준최5 이미지 7장 700', 1500, 1500],
    ['블로그', 'P02', '준최2~준최5 이미지 10장 1000', 1900, 1900],
    ['블로그', 'P02', '준최4~준최7 이미지 20장 2000', 3000, 3000],
    ['블로그', 'P02', '준최 4 원고세팅', 4000, 6000],
    ['블로그', 'P02', '수정/삭제비', 500, 500],
    ['블로그', 'P0B', '실계정 준최 4', 2000, 2000],
    ['블로그', 'P0B', '프리미엄 배포(원고 및 사진 지정)', 1000, 1000],
    ['블로그', 'P0B', '실계정 준최2~4 배포(사진10장)', 800, 800],
    ['블로그', 'P0B', '실계정 준최2~4 배포(사진5장)', 650, 650],
    ['블로그', 'P0B', '실계정 준최2~4 배포(사진3장)', 550, 550],
    ['블로그', 'P0B', '실계정 준최2~4 배포(사진1장)', 500, 500],
    ['블로그', 'AI 파라곤', '일반배포', 120, 120],
    ['블로그', 'AI 파라곤', '프리미엄 이미지 생성', 170, 170],
    ['블로그', 'P03', '준최 4~6 원고세팅', 10000, 11000],
    ['블로그', 'P03-A', '준최 4~6 원고세팅', 8000, 8000],
    ['블로그', '최적화블로그', '최블A+', 17000, 19000],
    ['블로그', '최적화블로그', '최블 B', 17000, 19000],
    ['블로그', '최적화블로그', '최블 C', 23000, 25000],
    ['블로그', '최적화블로그', '최블 D', 38000, 40000],
    ['블로그', '원고', '대필프로그램', 500, 700],
    ['블로그', '원고', '외주대필', 2000, 3000],
    ['블로그', '원고', '프리미엄원고대필', 10000, 11000],
    ['블로그', '파라곤', '247.0', 150, 180],
    ['블로그', '파라곤', '25.0', 100, 130],
    ['블로그', '스페이스', '[일반] 1장 일반', 300, 300],
    ['블로그', '스페이스', '[일반] 3장 일반', 300, 300],
    ['블로그', '스페이스', '[일반] 7장 일반', 400, 400],
    ['블로그', '스페이스', '[일반] 1장 프리미엄', 400, 400],
    ['블로그', '스페이스', '[일반] 3장 프리미엄', 400, 400],
    ['블로그', '스페이스', '[일반] 7장 프리미엄', 500, 500],
    ['블로그', '스페이스', '[올인원] 1장 일반', 350, 350],
    ['블로그', '스페이스', '[올인원] 3장 일반', 350, 350],
    ['블로그', '스페이스', '[올인원] 7장 일반', 450, 450],
    ['블로그', '스페이스', '[올인원] 1장 프리미엄', 450, 450],
    ['블로그', '스페이스', '[올인원] 3장 프리미엄', 450, 450],
    ['블로그', '스페이스', '[올인원] 7장 프리미엄', 550, 550],
    ['블로그', '스페이스', '[247] 1장 일반', 400, 400],
    ['블로그', '스페이스', '[247] 3장 일반', 400, 400],
    ['블로그', '스페이스', '[247] 7장 일반', 500, 500],
    ['블로그', '스페이스', '[247] 1장 프리미엄', 500, 500],
    ['블로그', '스페이스', '[247] 3장 프리미엄', 500, 500],
    ['블로그', '스페이스', '[247] 7장 프리미엄', 600, 600],
    ['블로그', 'HP', '247.0', 300, 350],
    ['블로그', 'HP', '25.0', 180, 200],
    ['블로그', '저인망', '준최 2', 900, 1000],
    ['블로그', '저인망', '준최 4 ', 1200, 1300],
    ['리뷰', 'ReviewFlow', '충전금', null, null],
    ['리뷰', '플레이스', 'A/S ReceiptNote', 400, 600],
    ['리뷰', '플레이스', 'A/S 영수증리뷰', 800, 900],
    ['리뷰', '플레이스', 'ReceiptNote', 400, 600],
    ['리뷰', '플레이스', 'N 영수증리뷰', 500, 600],
    ['리뷰', '플레이스', '영수증리뷰', 800, 900],
    ['리뷰', '플레이스', '예약자리뷰', 1300, 1400],
    ['리뷰', '카카오', '카카오맵리뷰', 500, 600],
    ['리뷰', '카카오', '카카오맵리뷰 원고요청', 600, 700],
    ['리뷰', 'T맵', 'T맵리뷰', 1500, 1600],
    ['리뷰', '구글', '구글리뷰', 1800, 2000],
    ['리뷰', '구글', '개별옵션', 200, 200],
    ['리뷰', '리뷰삭제', '빠른삭제', 35000, 37000],
    ['리뷰', '리뷰삭제', '일반삭제', 25000, 27000],
    ['리뷰', '클립리뷰', '25초내 영상형', 1800, 1900],
    ['리뷰', '클립리뷰', '10장 내 슬라이드형', 1800, 1900],
    ['리뷰', '캐치테이블', '캐치테이블리뷰', 3000, 3500],
    ['리뷰', '원고', '대필프로그램', 70, 70],
    ['카페', '맘카페', '단순배포', 6500, 7000],
    ['카페', '맘카페', '댓글작업', 1500, 1500],
    ['카페', '핫딜', '커뮤니티', null, null],
    ['인스타그램', '기자단', '단순배포', 10000, 12000],
    ['네이버 쇼핑', '가구매', '기자단', 1500, 1500],
    ['네이버 쇼핑', '가구매', '택배대행비', 1900, 1900],
    ['네이버 쇼핑', '스토어', '알림받기', 29, 31],
    ['네이버 쇼핑', '스토어', '찜', 29, 31],
    ['쿠팡', '쓰나미', '트래픽', 24000, 24000],
    ['쿠팡', 'MAX', '트래픽', 400, 417],
    ['쿠팡', '업팡', '트래픽', 670, 700],
    ['쿠팡', '가구매', '기자단', 1500, 1500],
    ['쿠팡', '가구매', '택배대행비', 1900, 1900],
    ['쿠팡', '가구매', '물품비', null, null],
    ['쿠팡2', '가구매2', '기자단2', 800, 900],
    ['쿠팡2', '가구매2', '택배대행비2', 1800, 1900],
    ['쿠팡2', '가구매2', '물품비', null, null],
    ['중화권마케팅', '샤오홍슈', '프리미엄', 58000, 63000],
    ['중화권마케팅', '샤오홍슈', '스탠다드', 20000, 25000],
    ['중화권마케팅', '샤오홍슈', '부띠끄', 20000, 25000],
    ['크몽작업', '수수료', '크몽 수수료', null, null],
    ['피크마케팅 상품', '상품', 'DB 프로그램', 20000, 20000],
    ['피크마케팅 상품', '상품', 'UI 최초사용료', 18000, 18000],
    ['피크마케팅 상품', '상품', '도메인 구입비', 18000, 18000],
    ['피크마케팅 상품', '상품', '스냅촬영', null, null],
    ['브랜드블로그', '베이직', '타입 A', 100000, 100000],
    ['브랜드블로그', '베이직', '타입 B', 150000, 150000],
    ['브랜드블로그', '스탠다드', '타입 A', 200000, 200000],
    ['브랜드블로그', '스탠다드', '타입 B', 300000, 300000],
    ['브랜드블로그', '스탠다드', '타입 C', 400000, 400000],
    ['브랜드블로그', '프리미엄', '타입 A', 280000, 280000],
    ['브랜드블로그', '프리미엄', '타입 B', 450000, 450000],
    ['브랜드블로그', '프리미엄', '타입 C', 550000, 550000],
    ['브랜드블로그', '옵션', '일반 대문이미지', 100000, 100000],
    ['브랜드블로그', '옵션', '홈페이지형 대문이미지', 200000, 200000],
    ['브랜드블로그', '옵션', '프리미엄포스팅 5건 변경', 100000, 100000],
    ['브랜드블로그', '옵션', '대문에서 홈페이지형 변경', 80000, 80000],
    ['당근', '리뷰', '비즈후기', 2000, 2200],
    ['당근', '찜', '찜', 200, 220],
    ['당근', '단골맺기', '단골맺기', 200, 220],
    ['당근', '동네생활', '단순배포', 6500, 7000],
    ['블로그', '브랜드블로그', '신규 스타터 입문형', 150000, 150000],
    ['블로그', '브랜드블로그', '신규 베이직 육성형', 290000, 290000],
    ['블로그', '브랜드블로그', '신규 프리미엄 육성형', 420000, 420000],
    ['블로그', '브랜드블로그', '신규 올인원 집중관리형', 570000, 570000],
    ['블로그', '브랜드블로그', '연장 스타터 입문형', 90000, 90000],
    ['블로그', '브랜드블로그', '연장 베이직 육성형', 250000, 250000],
    ['블로그', '브랜드블로그', '연장 프리미엄 육성형', 350000, 350000],
    ['블로그', '브랜드블로그', '연장 올인원 집중관리형', 420000, 420000],
    ['블로그', '브랜드블로그', '빠른 서로이웃', 25000, 25000],
    ['블로그', '브랜드블로그', '빠른 이웃', 15000, 15000],
    ['블로그', '브랜드블로그', '포스팅 반응활성화', 2000, 2000],
    ['블로그', '브랜드블로그', '카카오톡 채널 친구추가', 12000, 12000]
  ];

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

  // 하위 영업자의 개인정산서를 열어볼 수 있는 사람.
  const TEAM_SETTLEMENT_VIEWERS = ['김진봉', '패션TV봉이', '김대호', '박종원'];

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
    // 입력 중인 창은 바깥을 눌러도 닫지 않는다. 실수로 내용이 날아간다.
    modal.addEventListener('click', event => {
      if (event.target === modal && modal.dataset.locked !== 'true') closeDetailModal();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !modal.hidden) closeDetailModal();
    });
  }

  function openDetailModal(title, content, { locked = false } = {}) {
    const modal = document.getElementById('readonlyDetailModal');
    document.getElementById('readonlyModalTitle').textContent = title;
    document.getElementById('readonlyModalBody').innerHTML = content;
    modal.dataset.locked = locked ? 'true' : 'false';
    modal.hidden = false;
    body.style.overflow = 'hidden';
  }

  function closeDetailModal() {
    const modal = document.getElementById('readonlyDetailModal');
    modal.dataset.locked = 'false';
    modal.hidden = true;
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

  function applyUserIdentity() {
    const member = document.querySelector('.app-sidebar > .member');
    const name = userDoc.name || currentUser.displayName || currentUser.email || '사용자';
    const initials = name.slice(-2);
    member.innerHTML = `
      <div class="avatar">${esc(initials)}</div>
      <div class="member-copy"><strong>${esc(name)}</strong><small>${esc(userDoc.group_name || '소속 미지정')} · ${esc(currentOrgRank() === ORG_RANK_UNSET ? roleLabel(userDoc.role) : currentOrgRank())}</small></div>
      <button class="member-signout" id="memberSignout" type="button" title="로그아웃" aria-label="로그아웃">↪</button>`;
    member.querySelector('#memberSignout').addEventListener('click', async () => {
      await auth.signOut();
      location.reload();
    });
    prototypeBar.classList.add('live');
    prototypeBar.innerHTML = `
      <i aria-hidden="true"></i>
      <span>운영 데이터 · 읽기 전용 · ${esc(name)} 계정 권한으로 조회 중</span>
      <label class="persona-switch">
        <span>계정 미리보기</span>
        <select id="personaSelect">
          <option value="">내 계정 (${esc(realUserDoc?.name || name)})</option>
          ${orgRoster().map(row => `<option value="${esc(row.name)}" ${previewPersona === row.name ? 'selected' : ''}>${esc(row.name)} · ${esc(orgRankOf(row))} · ${esc(row.branch.name)}</option>`).join('')}
        </select>
      </label>`;
    prototypeBar.querySelector('#personaSelect').addEventListener('change', event => applyPersona(event.target.value));
    applyNavPermissions();
  }

  // 최종정산서 탭은 지정된 인원에게만 보인다.
  function applyNavPermissions() {
    const locks = { 'final-settlement': canSeeFinalSettlement() };
    Object.entries(locks).forEach(([view, allowed]) => {
      const button = document.querySelector(`.app-sidebar .nav-item[data-view="${view}"]`);
      if (!button) return;
      button.dataset.navLocked = allowed ? 'false' : 'true';
      button.hidden = !allowed;
    });
  }

  // 다른 사람 화면이 어떻게 보이는지 확인하는 용도. 화면 표시만 바뀌고
  // 서버에서 내려오는 데이터는 실제 로그인 계정 것 그대로다.
  function applyPersona(name) {
    previewPersona = name || '';
    if (!previewPersona) {
      userDoc = realUserDoc;
    } else {
      const row = orgRoster().find(item => item.name === previewPersona);
      const rank = row ? orgRankOf(row) : ORG_RANK_UNSET;
      userDoc = {
        ...realUserDoc,
        name: previewPersona,
        role: rank === '대표' ? 'admin' : (rank === '주임' ? 'member' : 'manager'),
        group_name: row ? (row.teamName || row.divisionName) : ''
      };
    }
    loadIntakeDraft();
    applyUserIdentity();
    // 권한이 사라진 화면을 보고 있었다면 되돌린다
    activateView(activeView === 'final-settlement' && !canSeeFinalSettlement() ? 'settlement' : activeView);
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

  function loadIntakeDraft() {
    try {
      const saved = JSON.parse(localStorage.getItem(intakeStorageKey()) || '[]');
      intakeDraft = Array.isArray(saved) ? saved : [];
    } catch (error) {
      intakeDraft = [];
    }
  }

  function saveIntakeDraft() {
    try {
      localStorage.setItem(intakeStorageKey(), JSON.stringify(intakeDraft));
    } catch (error) {
      /* 저장 공간이 막혀 있어도 화면 동작은 유지한다 */
    }
  }

  // 나중에 추가한 상품. 단가표는 회사 전체가 같이 쓰므로 계정별로 나누지 않는다.
  const CUSTOM_PRICE_KEY = 'peakos.customPrices';
  let customPrices = [];

  function loadCustomPrices() {
    try {
      const saved = JSON.parse(localStorage.getItem(CUSTOM_PRICE_KEY) || '[]');
      customPrices = Array.isArray(saved) ? saved : [];
    } catch (error) {
      customPrices = [];
    }
  }

  function saveCustomPrices() {
    try {
      localStorage.setItem(CUSTOM_PRICE_KEY, JSON.stringify(customPrices));
    } catch (error) {
      /* 저장 공간이 막혀 있어도 화면 동작은 유지한다 */
    }
  }

  // 기본 단가표 + 추가한 상품. 접수 화면과 단가표가 같은 목록을 본다.
  function priceRows() {
    return PRICE_TABLE.concat(customPrices);
  }

  function isCustomPrice(row) {
    return customPrices.includes(row);
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
    if (userDoc?.role === 'admin') return true;
    return FINAL_SETTLEMENT_VIEWERS.includes(String(userDoc?.name || '').trim());
  }

  function canSeeTeamSettlement() {
    if (userDoc?.role === 'admin') return true;
    return TEAM_SETTLEMENT_VIEWERS.includes(String(userDoc?.name || '').trim());
  }

  // 하위 계정 목록. 본사에서 자기를 뺀 나머지를 직급 순으로 보여 준다.
  function subordinateRoster() {
    const myName = String(userDoc?.name || '').trim();
    return orgRoster()
      .filter(row => row.branch.id === 'hq' && row.name !== myName && row.rank !== '대표')
      .sort((a, b) => orgRankOrder(orgRankOf(a)) - orgRankOrder(orgRankOf(b)));
  }

  // 개인정산서에 올라가는 건. 최종정산서에서만 적는 건은 빠진다.
  function personalRows() {
    return intakeDraft.filter(row => !row.finalOnly);
  }

  // 조회 조건에 맞는 접수만 걸러 낸다.
  function filteredIntake() {
    const f = intakeFilter;
    return personalRows().filter(row => {
      if (f.from && String(row.date) < f.from) return false;
      if (f.to && String(row.date) > f.to) return false;
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

  function renderIntakeFilter() {
    const clients = [...new Set(personalRows().map(row => row.client).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
    const products = [...new Set(personalRows().map(row => row.a).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
    const option = (value, label, selected) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;

    return `<div class="ledger-filter">
      <label class="ledger-filter-field">
        <span>기간</span>
        <span class="ledger-filter-range">
          <input type="date" data-ledger-filter="from" value="${esc(intakeFilter.from)}" aria-label="시작일">
          <em>~</em>
          <input type="date" data-ledger-filter="to" value="${esc(intakeFilter.to)}" aria-label="종료일">
        </span>
      </label>
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
      ${canSeeCompanyCost()
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
      form.memo = source.memo || '';
      form.a = source.a;
      form.b = source.b;
      form.c = source.c;
      form.sell = String(source.sell ?? '');
      if (!form.unit) form.unit = String(source.unit ?? '');
    }
    // 영업자 단가는 나중에 바뀔 수 있어 부장 이상만 고칠 수 있다.
    const lockBase = Boolean(source);
    const unitEditable = !lockBase || canSeeCompanyCost();
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
          ${variable && canSeeCompanyCost() ? `<label class="intake-field ${form.cost ? '' : 'need'}">
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
    const rows = intakeDraft.filter(row => ids.includes(row.id));
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
    const showCost = canSeeCompanyCost();
    const shown = filteredIntake();
    const month = intakeTotals(shown);

    if (!groups.length) {
      return `<section class="module-section">
        <div class="module-section-head"><span><strong>내 개인정산서</strong><small>접수한 건이 일자별로 쌓입니다</small></span></div>
        <div class="module-section-body">
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
        <span><strong>내 개인정산서</strong><small>${esc(userDoc?.name || '')} · ${intakeFilterActive()
          ? `조회 ${shown.length}건 / 전체 ${personalRows().length}건`
          : `접수 ${personalRows().length}건`}</small></span>
        <span class="module-chip live">매출 ${esc(month.sales.toLocaleString('ko-KR'))}원 · 영업이익 ${esc(month.profit.toLocaleString('ko-KR'))}원</span>
      </div>
      <div class="module-section-body">
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
  // 단가표 — 최종정산서에서는 회사원가까지, 개인정산서에서는 영업자단가만.
  let priceTableQuery = '';

  function renderPriceTableBody() {
    const showCost = intakeContext === 'final-settlement' && canSeeCompanyCost();
    const q = priceTableQuery.trim().toLowerCase().replace(/\s/g, '');
    const rows = priceRows().filter(row => !q || `${row[0]}${row[1]}${row[2]}`.toLowerCase().replace(/\s/g, '').includes(q));
    const won = value => value === null ? '상시변동' : Number(value).toLocaleString('ko-KR');

    return `<div class="sales-table-scroll price-table-scroll">
      <table class="sales-table price-table">
        <thead>
          <tr>
            <th scope="col">대분류</th>
            <th scope="col">중분류</th>
            <th scope="col">소분류</th>
            ${showCost ? '<th scope="col">회사원가</th>' : ''}
            <th scope="col">영업자단가</th>
          </tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map(row => `<tr class="${isCustomPrice(row) ? 'price-added' : ''}">
            <td>${esc(row[0])}</td>
            <td>${esc(row[1])}</td>
            <th scope="row">${esc(row[2])}${isCustomPrice(row) ? '<span class="kind-badge added">추가</span>' : ''}</th>
            ${showCost ? `<td class="${row[3] === null ? 'ledger-memo-empty' : ''}">${esc(won(row[3]))}</td>` : ''}
            <td class="${row[4] === null ? 'ledger-memo-empty' : ''}">${esc(won(row[4]))}</td>
          </tr>`).join('')
          : `<tr><td colspan="${showCost ? 5 : 4}" class="ledger-memo-empty">찾는 상품이 없습니다.</td></tr>`}
        </tbody>
      </table>
    </div>
    <p class="paid-hint">${esc(rows.length.toLocaleString('ko-KR'))}건 / 전체 ${esc(priceRows().length.toLocaleString('ko-KR'))}건${showCost ? '' : ' · 회사원가는 최종정산서에서만 볼 수 있습니다'}</p>`;
  }

  function openPriceTable() {
    priceTableQuery = '';
    const showCost = intakeContext === 'final-settlement' && canSeeCompanyCost();

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
    search.addEventListener('input', () => {
      priceTableQuery = search.value;
      document.getElementById('priceTableBody').innerHTML = renderPriceTableBody();
    });
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
      saveCustomPrices();
      form.hidden = true;
      ['newMajor', 'newMiddle', 'newMinor', 'newCost', 'newUnit'].forEach(id => { document.getElementById(id).value = ''; });
      document.getElementById('priceTableBody').innerHTML = renderPriceTableBody();
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
    const showCost = canSeeCompanyCost();
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
    const showCost = canSeeCompanyCost();
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
        ${moduleStatusbar('정산서', `${currentBranchName()} 정산 체계는 따로 준비합니다.`, '본사 먼저 적용')}
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
      ${moduleStatusbar('정산서', canSeeTeamSettlement() ? '시트접수와 하위 계정 정산서를 관리합니다.' : '로그인한 영업자의 개인정산 범위만 표시합니다.', '접수 초안 · 저장 전')}
      ${renderIntakeForm()}
      ${renderIntakeLedger()}
      ${teamSection}
      <div class="module-security"><span>▣</span><span><strong>현재 적용 권한: ${esc(currentOrgRank())}</strong><br>${canSeeCompanyCost()
        ? '회사 원가와 회사 기준 영업이익까지 표시됩니다. 대표·손명아·김대호·박종원·전현우만 볼 수 있습니다.'
        : '영업자 단가 기준으로만 표시되며 회사 원가는 감춥니다. 지금 구글 정산서와 같은 기준입니다.'}${canSeeFinalSettlement()
        ? ' 최종정산서는 지정된 인원에게만 열립니다.'
        : ' 최종정산서는 지정된 인원만 볼 수 있어 표시하지 않습니다.'}${canSeeTeamSettlement()
        ? ' 하위 계정 정산서도 열 수 있습니다.'
        : ''}</span></div>`;
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
    if (view === 'final-settlement') renderFinalSettlementModule();
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
      intakeFilter = { from: '', to: '', client: '', product: '', paid: '' };
      intakeSelection = [];
      renderPlannedModule(intakeContext);
    });

    moduleView.querySelectorAll('[data-paid-open]').forEach(button => button.addEventListener('click', () => {
      const picked = intakeSelection.length ? intakeSelection : [button.dataset.paidOpen];
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
        // 입금 확인 정보. 통장 연결 전이라 지금은 전부 수기로 채운다.
        paid: 'none',
        paidAmount: 0,
        payer: '',
        paidDate: '',
        paidMemo: '',
        paidAuto: false
      });
      saveIntakeDraft();
      intakeForm = { ...form, client: '', qty: '', sell: '', memo: '', unit: '', refOf: '', supplier: '', cost: '' };
      renderPlannedModule(intakeContext);
      showToast(intakeContext === 'final-settlement'
        ? '최종정산서에만 올라가는 건으로 등록했습니다.'
        : '접수를 등록했습니다. 이 브라우저에만 저장되는 초안입니다.');
    });

    moduleView.querySelectorAll('[data-intake-remove]').forEach(button => button.addEventListener('click', () => {
      intakeDraft = intakeDraft.filter(row => row.id !== button.dataset.intakeRemove);
      saveIntakeDraft();
      renderPlannedModule(intakeContext);
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

  function activateView(view) {
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
    if (activeNav) setNavClusterClosed(activeNav.closest('[data-nav-cluster]'), false);
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

    const search = document.getElementById('sidebarTabSearch');
    const submit = document.getElementById('sidebarTabSearchSubmit');
    const searchable = [...document.querySelectorAll('.nav-section .nav-item[data-tab-search]')];
    const navClusters = [...document.querySelectorAll('[data-nav-cluster]')];
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
      realUserDoc = userDoc;
      loadIntakeDraft();
      loadCustomPrices();
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
