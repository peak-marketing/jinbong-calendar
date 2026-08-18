# PEAK OS 작업 규칙

여러 에이전트(Claude 세션, Codex)와 사람이 **같은 서버·같은 저장소·같은 DB**를 공유합니다.
작업 시작 전에 이 문서를 먼저 읽고, 5장 체크리스트를 실행하세요.

## 1. 시스템 지도 (2026-08-18 확인)

| 프로세스 | 포트 | 코드 위치 | DB | 상태 |
|---|---|---|---|---|
| `calendar-business-os-api` | 4120 | `/root/workspaces/jinbong-calendar-business-os/server` | `calendar_db` | **실서비스** |
| `calendar-business-os-web` | 4190 | 같은 worktree | — | **실서비스** |
| `calendar-api` | — | `/var/www/jinbong-calendar/server` | `calendar_db` | 중지됨 (구 운영) |
| `calendar-redesign-api` | 4110 | `jinbong-calendar-redesign` | `calendar_redesign` | 별건 |

### 화면과 API가 서로 다른 곳에서 나갑니다 — 가장 헷갈리는 지점

```
paragon-info.kr/os/   →  /var/www/jinbong-calendar/os/   (nginx가 정적 파일 직접 서빙)
paragon-info.kr/api/  →  127.0.0.1:4120                  (이 저장소의 server/)
```

**화면 파일(`business-os-live.css`, `business-os-preview.js`)을 이 저장소에서 고치면 실서비스에 반영되지 않습니다.**
최종 목적지는 `/var/www/jinbong-calendar/os/` 입니다. 반영하려면:

```bash
# 1) 백업 (필수)
STAMP="작업이름-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p /var/www/jinbong-calendar/.deploy-backups/$STAMP
cp /var/www/jinbong-calendar/os/{business-os-live.css,business-os-preview.js,index.html}    /var/www/jinbong-calendar/.deploy-backups/$STAMP/

# 2) 반영
cp business-os-live.css   /var/www/jinbong-calendar/os/
cp business-os-preview.js /var/www/jinbong-calendar/os/

# 3) 캐시 버전 갱신 (os/index.html 쪽도 반드시)
sed -i 's/v=이전값/v=새값/g' /var/www/jinbong-calendar/os/index.html
```

nginx가 파일을 직접 읽으므로 **서버 재기동은 필요 없습니다.**
반영 후에는 반드시 실제 URL로 확인하세요 — 개발용 4190은 실서비스가 아닙니다.

```bash
curl -sk https://paragon-info.kr/os/ | grep -oE '\?v=[a-z0-9-]+'
```

`/var/www` 쓰기는 사람 승인이 필요합니다. 승인 없이 배포하지 마세요.
"프리뷰"라는 이름에 속지 마세요. 실사용자 데이터를 다룹니다.

**데이터베이스**
- `calendar_db` — **실서비스 데이터** (테이블 110, `peakos_*` 64)
- `calendar_business_os` — 미사용 (마지막 쓰기 2026-08-06)
- `*_rehearsal_*`, `*_20260817` — 마이그레이션 리허설 사본

## 2. 절대 하지 말 것

1. **`pm2 restart <name> --update-env` 금지.** 런타임 환경변수가 현재 셸 값으로 덮여 서비스가 죽습니다.
   2026-08-16에 실제로 프리뷰 API가 이 명령으로 중단됐습니다. 재기동은 `pm2 restart <name>`만 쓰세요.
2. **실서비스 DB(`calendar_db`) 스키마·데이터 변경은 사람 승인 없이 하지 마세요.**
3. **미커밋 변경이 있는 worktree에서 `git checkout` / `git stash` / `git reset --hard` 금지.**
   다른 에이전트 작업이 사라집니다.
4. **비밀값을 커밋하거나 출력하지 마세요** — `.env`, `firebase-service-account.json`, `PEAKOS_*` 시크릿.
5. 공유 포트를 임의로 점유하지 마세요 (3장 참고).

## 3. e2e 실행 규칙

`e2e/playwright.config.ts`가 포트 **4788 고정 + `reuseExistingServer: true`** 입니다.
두 에이전트가 동시에 돌리면 뒤에 실행한 쪽이 **앞 에이전트의 서버를 재사용해 남의 코드를 테스트하고 "통과"를 받습니다.** 경고도 에러도 없습니다.

```bash
E2E_PORT=<배정 포트> npx playwright test        # 반드시 자기 포트로
```

포트 배정: 1번 `4788` · 2번 `4789` · 3번 `4790`
설정이 아직 `E2E_PORT`를 읽지 않으면, 테스트를 돌리기 전에 그것부터 고치세요.

전체 실행은 약 15분(357개)입니다. 자기 기능만 빠르게 볼 때는 `-g` 로 좁히세요.

## 4. 화면 파일을 고쳤으면 버전을 올리세요

`business-os-preview.html`이 CSS/JS를 `?v=...` 쿼리로 캐시버스팅합니다.

```html
href="./business-os-live.css?v=20260818-board-density1"
src="./business-os-preview.js?v=20260818-board-density1"
```

**`business-os-live.css` 또는 `business-os-preview.js`를 고쳤으면 이 값을 반드시 함께 바꾸세요.**
안 바꾸면 브라우저가 예전 파일을 계속 써서, 고친 내용이 화면에 안 나타납니다.
형식은 `YYYYMMDD-작업이름N` 입니다. 두 곳 모두 같은 값으로 맞추세요.

## 5. 마이그레이션 규칙

- 자동 러너가 없습니다. 수동 적용입니다.
  ```bash
  sudo -u postgres psql -d <db> -v ON_ERROR_STOP=1 -f server/migrations/<파일>.sql
  ```
- 반드시 `server/migrations/YYYYMMDD_*.sql` 파일로 **커밋**하세요.
- **추가 전용.** 기존 컬럼·테이블 삭제 금지.
- 선행 마이그레이션 존재를 검사하고 없으면 `RAISE EXCEPTION` 하도록 작성하세요 (기존 파일 패턴을 따르세요).
- **실서비스 적용은 사람 승인 후에만.** 리허설 DB에서 먼저 검증하세요.

## 6. 작업 시작 전 체크리스트

1. `git status` — **남의 미커밋 작업이 보이면 멈추고 사람에게 알리세요.** 그 위에 작업하지 마세요.
2. `pm2 list` — 서비스가 살아 있는지 확인.
3. 큰 리팩터링(파일 분할, 브랜치 병합 등) 전에는 반드시 사람 확인.

## 7. git 규칙

- 트렁크는 `feature/business-os-dashboard` 입니다. `main`은 2026-04-07에서 멈춰 있습니다.
- 브랜치는 `tab/<탭이름>`, **한 탭에 한 명**.
- **하루 최소 1회 커밋.** 2026-08-17에 13,220줄이 25시간 미커밋으로 방치된 적 있습니다.
- 하루 1회 `git pull --rebase`.
- 커밋은 기능 단위로 나누세요.

## 8. 충돌 핫스팟

탭 코드 본문은 서로 안 부딪힙니다. 부딪히는 곳은 여기뿐입니다.

| 파일 | 위치 | 규칙 |
|---|---|---|
| `business-os-preview.js` | 상단 공유 상태 선언부 | 새 상태는 자기 탭 섹션 안에서 선언 |
| `business-os-preview.js` | `activateView()` | 한 줄 추가만 |
| `business-os-preview.html` | nav 버튼 블록 | 한 줄 추가만 |
| `business-os-live.css` | 파일 끝 | 탭별 파일로 분리 후 작업 |
| `server/index.js` | 라우트 배선 | 모듈은 별도 파일에, 배선만 한 줄 |
