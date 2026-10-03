# gstack 전수조사 분석 리포트 (한국어)

> 2026-10-03 작성 · 분석 대상 커밋 `e9a4065` · VERSION `1.87.4.0`

## 저장소 정보

| 항목 | 내용 |
|---|---|
| 우리 포크 | https://github.com/bmshin94/gstack |
| 원본 | https://github.com/garrytan/gstack (Garry Tan, Y Combinator 대표/CEO) |
| 라이선스 | MIT (상업적 사용·수정·재배포 자유) |
| 버전 | 1.87.4.0 |
| 규모 | 추적 파일 2,290개 / 76MB / 스킬 54개 / CLI 도구 90여 개 / 테스트 파일 743개(약 8,700개 테스트) |
| 포크 차이 | `CLAUDE.md`에 페르소나 가이드 26줄 추가 (`b00bbb9`, PR #1) |

설치 경로는 `~/.claude/skills/gstack`. `./setup`이 10개 AI 호스트를 감지해
스킬을 각각 렌더링하고 설치한다.

---

## 1. 이게 뭐하는 것인가

한 줄 요약: **Claude Code를 혼자서 20명짜리 엔지니어링 팀처럼 쓰게 만드는 워크플로우 패키지.**

`ARCHITECTURE.md`의 자기 정의:
> gstack gives Claude Code a set of opinionated workflow skills and a browser to see with.

구성은 두 덩어리다.

### A. 역할극하는 AI 전문가 54명 (Markdown 스킬)

각 폴더가 하나의 `/명령어`다. 폴더를 열면 코드가 아니라 긴 영어 지시서(`SKILL.md`)가 있다.

**기획·전략**
- `/office-hours` (1,278줄) — YC 오피스아워 모드. 아이디어를 캐묻고 전제를 공격
- `/plan-ceo-review` (1,179줄) — CEO 관점 스코프 공격, 10섹션 검토
- `/plan-eng-review` (758줄) — 아키텍처 확정, ASCII 다이어그램, 테스트 매트릭스
- `/plan-design-review`, `/plan-devex-review`, `/spec`, `/autoplan`(전체 파이프라인 연쇄)

**코드 품질**
- `/review` (979줄) — 랜딩 전 PR 리뷰. 자동수정 / 승인요청 분리
- `/cso` (170줄) — OWASP + STRIDE 보안감사
- `/health`, `/investigate`(근본원인 디버깅), `/careful`·`/freeze`·`/guard`(위험명령 가드레일)

**디자인**
- `/design-review` (1,953줄, 최대) — AI 슬롭 패턴 탐지
- `/design-consultation`, `/design-shotgun`, `/design-html`

**QA·브라우저**
- `/qa`, `/qa-only`, `/browse`, `/scrape`, `/skillify`, `/canary`, `/benchmark`
- iOS 전용: `/ios-qa`, `/ios-fix`, `/ios-design-review`, `/ios-sync`, `/ios-clean`

**출하**
- `/ship` (1,125줄) — 베이스 머지 → 테스트 → 리뷰 → VERSION 범프 → CHANGELOG → PR
- `/land-and-deploy`, `/document-release`, `/retro`, `/context-save`·`/context-restore`

### B. 실제 브라우저를 조종하는 엔진

Playwright 기반 Chromium 데몬을 상주시키고 컴파일된 CLI(`$B`)가 localhost HTTP로 명령을 던진다.

```
Claude Code → CLI(컴파일 바이너리) → Bun.serve 서버 → CDP → Chromium(상주)
첫 호출 약 3초, 이후 100~200ms
```

왜 데몬인가: 매번 브라우저를 켜면 툴콜마다 3~5초가 날아가고 쿠키·로그인 세션이 사라진다.
macOS에서는 Aside 브라우저(사용자의 실제 로그인 세션)를 1순위로 쓰고, 없으면 자체 Chromium으로
자동 폴백한다. `goto / snapshot / click / fill / screenshot / pdf / scrape / cdp` 등 60개 이상의 명령.

### 숨은 엔지니어링 (이 레포의 진짜 가치)

1. **SKILL.md는 생성물이다.** `.tmpl` + `scripts/gen-skill-docs.ts` 리졸버로 54개 스킬을
   10개 호스트(Claude Code, Codex, Cursor, OpenCode, Factory, Kiro, Slate, OpenClaw, Hermes, GBrain)용으로
   각각 렌더링. `hosts/*.ts` 하나 추가하면 새 호스트 지원 완료, 코드 변경 0줄.
2. **컨텍스트 토큰 예산을 CI가 감시한다.** 전체 스킬 frontmatter 합계를 1,150 토큰으로 제한
   (`test/catalog-budget.test.ts`), 스킬당 eager 토큰 상한을 fixture에 고정하고 초과 시 CI 실패.
   줄어들면 fixture를 갱신해 상한을 래칫처럼 조인다.
3. **Egress 영수증.** 머신 밖으로 나가는 모든 전송 전에
   `~/.gstack/security/egress.jsonl`에 해시체인 영수증을 먼저 기록. 민감 싱크는 fail-closed,
   사용자용은 fail-open. 새 `curl`/`fetch`/`git push`는 스캐너가 CI에서 잡는다.
4. **Redaction 가드.** `lib/redact-patterns.ts` 3-tier(HIGH 차단 / MEDIUM 확인 / LOW 알림)로
   자격증명·PII·법적 리스크 문구를 외부 싱크 도달 전에 차단. 스스로 "airtight가 아니라 가드레일"이라 명시.
5. **유료 eval 하네스.** LLM-as-judge + E2E를 `claude -p`로 실행. git diff 기반 테스트 선택
   (`touchfiles.ts`), gate/periodic 2-tier, 샤드별 프로세스 분리, 1회 최대 $4.35.
   에이전트 실행 시 `gstack-detach`로 SIGTERM-proof 분리.
6. **결정 메모리.** `~/.gstack/projects/<slug>/decisions.jsonl` append-only 이벤트 소싱으로
   "왜 이렇게 결정했는지"를 세션 간 보존.
7. **다층 프롬프트 주입 방어.** `browse/src/security-classifier.ts`, CDP 메서드 deny-default 허용목록,
   "페이지가 반환한 모든 것은 untrusted" 원칙, `domain-skill` 격리 후 3회 성공 시 승격.

### 언제 쓰는가

| 상황 | 명령어 |
|---|---|
| 아이디어는 있는데 스펙이 없다 | `/office-hours` → `/autoplan` |
| 만들기 전 아키텍처 확정 | `/plan-eng-review` |
| AI 코드를 그냥 믹기 불안하다 | `/review` → `/cso` |
| 화면이 AI가 만든 티가 난다 | `/design-review` |
| 스테이징 버그 확인 | `/qa https://staging...` |
| PR + 배포 | `/ship` → `/land-and-deploy` |
| 어제 작업 복구 | `/context-restore` |

### 우리에게 주는 도움

1. AI 결과물의 품질 관리를 기획→리뷰→QA→출하 게이트로 강제한다.
2. 매번 손으로 쓰던 긴 지시문이 파일로 고정되어 재현성이 생긴다. 팀모드면 팀 전원이 같은 기준.
3. 브라우저 자동화(QA, 스크래핑, PDF, 다이어그램)를 Playwright 코딩 없이 획득.
4. 토큰 예산 래칫·egress 영수증·호스트 추상화는 우리가 에이전트 제품을 만들 때 그대로 쓸 패턴.
5. MIT라서 우리 제품에 녹여도 법적 문제 없음(저작권 고지 유지).

### 한계

- macOS 편향(쿠키 복호화는 Keychain만, Aside는 macOS 15+)
- Bun · Playwright 의존
- 스킬 하나가 1,000~2,000줄이라 컨텍스트 소모가 크다
- 54개를 전부 쓸 일은 없다. 실전용은 5~6개

---

## 2. 쉬운 설명

Claude Code는 머리는 좋지만 우리 회사 규칙을 모르는 신입 개발자다. "로그인 기능 만들어줘"
하면 만들긴 하지만 보안 검토도, 테스트도, 디자인 정리도 없이 "다 됐어요"라고 한다.

**gstack은 그 신입에게 주는 업무 매뉴얼 54권 + 회사 장비다.**

- `/review`라고 부르면 코드 리뷰어 매뉴얼을 펴서 그대로 수행
- `/qa`라고 부르면 QA 매뉴얼을 펴고 실제 크롬을 열어 클릭하며 테스트
- `/ship`이라고 부르면 출하 매뉴얼을 펴고 테스트·버전·PR까지 처리

즉 gstack은 프로그램이 아니라 **지시서 묶음**이다.

### 폴더 구조

```
gstack/
├── review/SKILL.md        코드 리뷰 지시서 979줄
├── qa/SKILL.md            QA 지시서 960줄
├── ship/SKILL.md          출하 지시서 1,125줄
├── ... (스킬 54개)
├── browse/                실제 코드. 브라우저 조종 프로그램(TypeScript)
├── design/, make-pdf/     실제 코드. PDF·디자인 도구
├── bin/                   90여 개 CLI 도구(버전범프, 비밀정보검사 등)
├── scripts/               지시서를 템플릿에서 생성하는 빌드 도구
├── test/                  743개 테스트 파일. 지시서 품질까지 테스트
└── hosts/                 10개 AI 도구별 변환 설정
```

### 지시서를 테스트한다는 뜻

- **무료 테스트** (`bun run test`, 90~100초, 약 8,700개): 오타·깨진 링크,
  템플릿 수정 후 생성물 미커밋, 토큰 예산 초과를 잡는다.
- **유료 테스트** (`bun run test:evals`, 1회 최대 $4.35): 실제로 Claude를 호출해 지시서를 읽히고
  다른 Claude가 심판이 되어 점수를 매긴다. "진짜 버그를 찾았나", "위험한 명령을 거부했나"를 검사.
  수정 파일에 따라 돌릴 테스트만 자동 선택해 비용을 줄인다.

핵심 정체성: **프롬프트를 소프트웨어처럼 CI로 관리한다.**

### 하루 흐름 (README 예시)

```
/office-hours        → "브리핑 앱이 아니라 개인 비서 AI입니다" 반박, 기능 5개 추출
/plan-ceo-review     → 스코프 10섹션 검토
/plan-eng-review     → 데이터 흐름, 실패 모드, 테스트 매트릭스
승인                 → 11개 파일 2,400줄, 약 8분
/review              → 자동수정 2건, 확인요청(경쟁상태) 1건
/qa https://staging  → 실제 브라우저로 클릭, 버그 발견·수정
/ship                → 테스트 42→51개, PR 생성
```

### 비유

- 브라우저 데몬 = 매번 시동 끄지 않고 엔진을 켜두는 것 (3초 → 0.1초)
- Egress 영수증 = 편지를 보낼 때마다 등기 영수증을 먼저 금고에 넣는 것
- 토큰 예산 래칫 = 체중계. 한번 빠진 몸무게가 새 상한선이 된다

---

## 3. 질문 답변

### 설치 및 사용법

**요건**: Claude Code(또는 지원 호스트), Git, Bun v1.0+, Windows는 Node.js 추가,
macOS 권장 Aside 브라우저(없으면 자체 Chromium 빌드), `/cso`는 C 툴체인 필요
(Linux static C 컴파일러 / macOS Xcode CLT / Windows VS 2022 Build Tools).

개인 설치:
```bash
git clone --single-branch --depth 1 https://github.com/bmshin94/gstack.git ~/.claude/skills/gstack \
  && cd ~/.claude/skills/gstack && ./setup
```

팀 모드:
```bash
(cd ~/.claude/skills/gstack && ./setup --team) \
  && ~/.claude/skills/gstack/bin/gstack-team-init required \
  && git add .claude/ CLAUDE.md && git commit -m "require gstack for AI-assisted work"
```

다른 호스트: `./setup --host codex|cursor|opencode|factory|kiro|slate|openclaw|hermes|gbrain`

주요 플래그: `--prefix`(`/gstack-review` 형태), `--no-prefix`(기본), `--model <id>`(Codex 프로필), `--no-team`

운영 명령: `/gstack-upgrade`, `bin/gstack-uninstall`, `bin/gstack-relink`, `bun run skill:check`

처음 사용 순서(README 권장): `/office-hours` → `/plan-ceo-review` → `/review` → `/qa <URL>`

### 플러그인인가, 스킬인가, MCP인가

**스킬(Agent Skills)이다.**

| 분류 | 판정 | 근거 |
|---|---|---|
| Claude Code Skill | 해당 | 54개 `SKILL.md`에 `name:`/`description:`/`allowed-tools:` frontmatter, `~/.claude/skills/`에 설치 |
| Plugin | 아님 | `.claude-plugin/`, `plugin.json`, `marketplace.json` 전부 없음 |
| MCP 서버 | 아님 | ARCHITECTURE.md 명시: "No MCP protocol. MCP adds JSON schema overhead per request... Plain HTTP + plain text output is lighter on tokens" |

단, 순수 스킬은 아닌 하이브리드다.
- CLI 바이너리 번들: `browse`, `pdf`, `design` (Bun compile)
- Hook 설치: `settings.json`에 `PreToolUse`/`PostToolUse` 훅 등록
- MCP는 선택적 연동 대상: `/setup-gbrain`에서 gbrain을 붙일 때 MCP를 쓰기만 한다

한 줄: **스킬 54개 + 자체 CLI 3개 + 훅 몇 개로 구성된 Claude Code 확장 팩.**

### API 토큰이 필요한가

일반 사용자는 필요 없다.

| 용도 | 필요 | 비고 |
|---|---|---|
| 스킬 사용(`/review`, `/qa`, `/ship` …) | 불필요 | Claude Code 자체 인증 사용 |
| 브라우저 도구(`$B`, `/scrape`) | 불필요 | 로컬 Chromium |
| gstack 개발·eval 테스트 | `ANTHROPIC_API_KEY` | `.env.example`의 유일한 항목, `bun run test:evals`용 |
| `/codex` | Codex CLI 자체 인증 | `${CODEX_HOME}/auth.json`, `OPENAI_API_KEY` 불필요 |
| `/pair-agent` 터널 | ngrok 토큰 | 원격 에이전트 연결 시 |
| gbrain + Supabase | Supabase 키 | 선택 |
| `/design` OpenAI 호출 | 선택 | fail-open 사용자용 싱크 |

모든 외부 전송은 `~/.gstack/security/egress.jsonl`에 기록되고
`bin/gstack-egress list | verify | grants`로 추적 가능(변조 시 `verify` exit 3).

### AI 에이전트 구축에 도움이 되는가

된다. 코드보다 설계 교본으로서의 가치가 더 크다.

| 패턴 | 참고 위치 | 중요성 |
|---|---|---|
| 프롬프트를 코드처럼(템플릿→생성→테스트→CI) | `scripts/gen-skill-docs.ts`, `scripts/resolvers/` | 프롬프트 드리프트를 CI가 차단 |
| 컨텍스트 예산 관리 | `test/catalog-budget.test.ts`, `bin/gstack-context-bill` | 에이전트 비용·품질의 핵심 |
| LLM-as-judge eval 하네스 | `test/skill-llm-eval*.test.ts`, `scripts/test-paid-shards.ts` | 품질을 숫자로, diff 기반 비용 절감 |
| Hermetic 테스트 환경 | `test/helpers/hermetic-env.ts` | env 허용목록 스크럽 + 임시 HOME으로 재현성 |
| 데몬 + CLI 툴 설계 | `browse/src/server.ts` | 툴콜 지연 3초 → 0.1초 |
| Egress 영수증 + Redaction | `lib/egress-receipt.ts`, `lib/redact-engine.ts` | 데이터 유출 감사, 엔터프라이즈 필수 요건 |
| 멀티 호스트 추상화 | `hosts/*.ts`, `docs/ADDING_A_HOST.md` | 한 프롬프트 자산을 10개 플랫폼에 배포 |

### React나 PHP로 만들 수 있는가

| 레이어 | React/TS | PHP | 설명 |
|---|---|---|---|
| 스킬 54개(Markdown) | 그대로 사용 | 그대로 사용 | 텍스트라 언어 무관 |
| generator(`gen-skill-docs`) | 쉬움(이미 TS) | 가능 | 템플릿 치환 |
| 브라우저 데몬 | 자연스러움 | 비권장 | Playwright 공식 지원은 Node/Python/Java/.NET. PHP 공식 바인딩 없음 |
| PDF·디자인 도구 | 가능 | 비권장 | Chromium CDP 의존 |
| 웹 대시보드·SaaS 래퍼 | 최적 | 최적 | PHP의 자리 |

결론:
- React는 매우 적합. 특히 웹 대시보드(eval 비교, 리뷰 히스토리, 디자인 변형 비교보드, egress 영수증 뷰어).
  백엔드가 이미 Bun/TS라 모노레포로 붙이면 된다.
- PHP로 브라우저 엔진을 재구현하지 말 것. Laravel로 관리·과금·팀 관리 SaaS 레이어를 올리고
  실제 에이전트 실행은 Bun/Node 워커에 큐(Redis/SQS)로 던지는 하이브리드가 정답.
- 추천 조합: Next.js 프론트 + Bun/TS 에이전트 러너 + Laravel 또는 Supabase로 과금·인증.

### 유튜브 강의 영상 제작

가능하다. MIT라서 강의·리뷰·수익화 모두 자유. 지킬 것:
1. 코드 배포 시 저작권 고지 유지
2. 원작자 Garry Tan과 레포 주소를 설명란에 명시
3. `NOTICE.md`에 Apache-2.0 파생 파일(impeccable by Paul Bakaus, Google design.md 스펙)이 있어
   코드 재배포 시 `licenses/Apache-2.0.txt` 동반 필요. 영상 제작만이면 무관
4. `ETHOS.md`는 Garry 개인 철학 문서. 인용은 가능하나 수정 배포는 프로젝트 규칙상 금지

강점: 화자가 YC 대표라는 후킹, README의 "2013년 대비 810배 생산성" 숫자 훅,
한국어 콘텐츠 공백, 30초 설치로 시연이 쉬움.

**커리큘럼 초안 (8화)**

| 화 | 제목 | 길이 | 포인트 |
|---|---|---|---|
| 1 | YC 대표가 만든 AI 개발 스킬 54개, 30초 설치 | 10분 | 설치+첫 실행, 유입 훅 |
| 2 | `/office-hours`로 아이디어 해부하기 | 15분 | AI가 기획을 반박하는 장면 |
| 3 | `/review` + `/cso` — AI 코드를 그냥 믹으면 안 되는 이유 | 15분 | 실제 버그 발견이 하이라이트 |
| 4 | `/qa` — AI가 내 브라우저를 직접 클릭한다 | 12분 | 가장 비주얼하게 강력 |
| 5 | `/ship` — PR까지 자동, 커밋 바이섹트 규율 | 12분 | 실무자 타깃 |
| 6 | 나만의 스킬 만들기(`.tmpl` → `gen:skill-docs`) | 20분 | 실습 핵심 |
| 7 | 프롬프트를 CI로 테스트한다(eval 하네스) | 20분 | 고급 시청자 차별화 |
| 8 | 커스텀 페르소나 붙이기(우리 포크 사례) | 10분 | `CLAUDE.md` 예시 |

3·4화가 조회수를 캐리할 가능성이 높고, 6화부터 유료 강의 전환을 유도하는 구성.

---

## 4. 수익화 아이디어 상세

MIT 라이선스라 아래 전부 합법이다.

### 티어 1 — 즉시 실행, 코드 0줄

**① 유튜브 + 온라인 강의**
- 무료 유튜브 8화 → 유료 심화 강의(인프런/클래스101/Udemy)
- 가격: 심화 99,000~199,000원
- 근거: AI 코딩 수요 폭발 + YC 대표 권위 + 한국어 콘텐츠 공백
- 예상: 수강생 300명 × 99,000원 = 약 3,000만원(수수료 전)
- 리드타임: 2~4주 / 리스크: 낮음

**② 기업 교육·사내 워크숍**
- 반일(4h) 200~400만원 / 1일(8h) 400~800만원
- 타깃: 스타트업 개발팀, SI 업체, 대기업 DX 조직
- 킬러 포인트: 고객사 `CLAUDE.md`에 맞춘 gstack 커스터마이징 번들 → 재구매 유발
- 예상: 월 2건 × 300만원 = 월 600만원
- 리드타임: 3~6주(레퍼런스 1건 필요)

**③ 기술 뉴스레터·유료 멤버십**
- 주간 "AI 코딩 워크플로우" 뉴스레터, 유료 티어에 템플릿 번들
- 가격: 9,900원/월, 구독자 300명 = 월 300만원
- 리드타임: 즉시 시작, 6~12개월 빌드업 필요

### 티어 2 — 코드 조금, 마진 좋음

**④ 산업별 스킬팩 판매 (최고 추천)**
- `/fintech-review`(전자금융감독규정·PCI-DSS), `/medical-review`(의료기기 SW 밸리데이션·HIPAA),
  `/gov-review`(공공 SW 과업지시서 준수), `/ecommerce-qa`(결제·장바구니 플로우)
- 근거: gstack은 의도적으로 플랫폼 중립이다. `CLAUDE.md`에
  "Skills must NEVER hardcode framework-specific commands"라고 명시되어 있다.
  즉 도메인 지식 레이어가 비어 있고 그 자리가 우리 몫이다.
- 가격: 팩당 300,000~1,500,000원 또는 50,000원/월 구독
- 예상: 팩 3개 × 50고객 × 500,000원 = 7,500만원
- 리드타임: 팩당 2~4주 / 방어력: 도메인 규제 지식은 복제 난이도가 높다

**⑤ 한국 로컬라이즈 배포판**
- 한국어 스킬 + 국내 스택 프리셋(네이버클라우드/카카오, 토스페이먼츠, 알리고 SMS 등)
  + 개인정보보호법 패턴을 `redact-patterns.ts`에 추가
- 모델: 오픈소스 무료 + 지원·커스터마이징 유료
- 가격: 설치·커스터마이징 500만원 / 연 유지보수 1,200만원
- 예상: 고객 5개사 = 연 6,000만원 / 리드타임 6~10주

**⑥ GitHub Sponsors**
- 포크를 가치 있는 배포판으로 키워 후원 유치
- 예상: 월 $100~1,000. ④⑤의 마케팅 채널로서의 가치가 더 크다

### 티어 3 — 제품화

**⑦ AI 코드 품질 게이트 SaaS (가장 큰 그림)**
- `/review` + `/cso` + eval 하네스를 CI 봇 + 웹 대시보드로 제품화
  - PR 자동 리뷰 → 인라인 코멘트
  - AI 생성 코드 품질 리포트(차별점)
  - egress 영수증 기반 데이터 유출 감사 리포트(엔터프라이즈 결제 포인트)
  - 팀 단위 프롬프트 자산 관리 + 토큰 청구서(`gstack-context-bill` 응용)
- 스택: Next.js 대시보드 + Bun/TS 에이전트 워커 + Supabase/Postgres
- 가격: Team 50,000원/시트/월, Enterprise 연 3,000만원
- 예상: 시트 200개 = 월 1,000만원(ARR 약 1.2억)
- 리드타임: MVP 3개월, 상용 6개월
- 경쟁: CodeRabbit, Greptile, Graphite. 차별점은 AI 생성 코드 전용 + 감사 추적

**⑧ AI 개발 전환 컨설팅**
- 현황 진단 → 워크플로우 설계 → gstack 커스터마이징 → 교육 → 성과 측정
- 가격: 프로젝트당 3,000만~1억원, 연 3건 = 연 1.5억원
- 리드타임: 레퍼런스 확보에 3~6개월
- 난점: 사람 품이 많이 들고 스케일되지 않는다. 다만 ⑦의 진입 쐐기로는 최적

**⑨ 책·전자책**
- 『AI 에이전트 워크플로우 설계』 — gstack을 레퍼런스 구현으로 쓰는 실무서
- 예상: 3,000부 × 30,000원 × 10% = 900만원. 수익보다 권위 확보 목적
- 리드타임: 4~6개월

### 비교표

| # | 아이디어 | 투입 | 리드타임 | 1년 예상 | 추천 |
|---|---|---|---|---|---|
| ① | 유튜브+강의 | 낮음 | 2~4주 | 3,000만 | 높음 |
| ② | 기업 교육 | 낮음 | 3~6주 | 7,200만 | 높음 |
| ③ | 뉴스레터 | 낮음 | 즉시(느린 성장) | 3,600만 | 중간 |
| ④ | 산업별 스킬팩 | 중간 | 2~4주/팩 | 7,500만 | 높음 |
| ⑤ | 한국 배포판 | 중간 | 6~10주 | 6,000만 | 중간 |
| ⑥ | Sponsors | 낮음 | 느림 | 500만 | 낮음 |
| ⑦ | 품질게이트 SaaS | 높음 | 6개월 | ARR 1.2억 | 높음 |
| ⑧ | 컨설팅 | 중간 | 3~6개월 | 1.5억 | 중간 |
| ⑨ | 책 | 중간 | 4~6개월 | 900만 | 낮음 |

### 실행 순서

```
0~1개월   ① 유튜브 3화 공개 → 권위·유입 확보
1~2개월   ④ 산업별 스킬팩 1개(가장 잘 아는 도메인)
2~3개월   ② 기업 교육 첫 수주(유튜브가 리드 생성)
3~6개월   ⑧ 컨설팅 1건 → ⑦ SaaS 요구사항을 현장에서 수집
6~12개월  ⑦ SaaS MVP 출시(컨설팅 고객이 첫 유료 고객)
```

전략: ①로 신뢰, ④로 첫 현금, ⑧로 고객 문제 학습, ⑦로 스케일.
콘텐츠 → 제품 → 플랫폼 순서.

### 리스크

1. **원작자 의존** — 원본 방향이 바뀌면 영향. 포크 독립성을 유지하고 우리 스킬팩에 가치를 집중
2. **플랫폼 리스크** — Anthropic이 유사 기능을 기본 제공할 수 있다. 도메인 지식(④)이 방어선
3. **macOS 편향** — 기업 환경은 Windows가 많다. 리눅스·윈도 폴백 경로 강화가 차별점이 될 수 있다

---

## 참고 문서

| 파일 | 내용 |
|---|---|
| `README.md` | 설치, 스킬 목록, 호스트별 설정 |
| `ARCHITECTURE.md` | 코어 아이디어, 데몬 모델, 보안 모델, ref 시스템, 템플릿 시스템 |
| `CLAUDE.md` | 개발 규칙, 테스트 명령, CHANGELOG·VERSION 정책 |
| `BROWSER.md` | 브라우저 사용자 가이드 |
| `docs/PROJECT_STRUCTURE.md` | 전체 디렉터리 주석 트리 |
| `docs/TESTING_INTERNALS.md` | hermetic 환경, 샤드 러너, eval 내부 |
| `docs/ADDING_A_HOST.md` | 새 AI 호스트 추가 방법 |
| `ETHOS.md` | 원작자 빌더 철학(수정 배포 금지) |
| `NOTICE.md` | Apache-2.0 파생 파일 고지 |
