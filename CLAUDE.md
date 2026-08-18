# CLAUDE.md

이 저장소의 작업 규칙은 [AGENTS.md](./AGENTS.md)에 있습니다. **작업 시작 전에 먼저 읽으세요.**

Codex와 Claude 세션이 같은 서버·저장소·DB를 공유하므로 두 도구가 같은 규칙을 따라야 합니다.
규칙을 고칠 일이 생기면 `AGENTS.md` 한 곳만 고치세요.

특히 자주 사고가 나는 세 가지입니다.

1. `pm2 restart --update-env` 는 서비스를 죽입니다. 절대 쓰지 마세요.
2. 이 저장소는 "프리뷰"가 아니라 **실서비스**입니다 (`paragon-info.kr` → 4190, DB `calendar_db`).
3. 작업 전 `git status`로 다른 에이전트의 미커밋 변경이 있는지 확인하세요.
