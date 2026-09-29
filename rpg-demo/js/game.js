// 게임 루프 — 01_시스템기획서.md 5.5 UI 흐름(타이틀→마을→필드/던전→전투→결과) 반영
// 파티는 3종족이 항상 같은 레벨/경험치를 공유하는 것으로 단순화했다(실제 설계는 개별 레벨로 바꿀 수 있음).
// 상점 가격 등은 E1~E3 미결정이라 순전히 데모용 임시값이다.

let species, monstersData, elementsData, config, skillDefs, equipmentData;

const state = {
  exp: 0,
  level: 1,
  gold: 0,
  clearedStage: 0, // 0 = 아직 1스테이지도 안 깸
  hpRatio: { tank: 1, phys_dps: 1, mage_healer: 1 }, // 마을 밖에서 유지되는 체력 비율(전투 종료 시점 그대로)
};

const STAGE_COUNT = 5; // D3: 한 지역에 5스테이지

async function loadData() {
  const [sp, mo, el, cf, sk, eq] = await Promise.all([
    fetch("data/species.json").then((r) => r.json()),
    fetch("data/monsters.json").then((r) => r.json()),
    fetch("data/elements.json").then((r) => r.json()),
    fetch("data/config.json").then((r) => r.json()),
    fetch("data/skills.json").then((r) => r.json()),
    fetch("data/equipment.json").then((r) => r.json()),
  ]);
  species = sp.species;
  monstersData = mo;
  elementsData = el;
  config = cf;
  skillDefs = sk;
  equipmentData = eq;
}

function levelFromExp(exp) {
  for (let lv = 30; lv >= 1; lv--) {
    if (statAtLevel(config.expCurve, lv) <= exp) return lv;
  }
  return 1;
}

function buildParty() {
  const byId = Object.fromEntries(species.map((s) => [s.id, s]));
  const equip = equipmentData.playerEquipment;
  const order = ["tank", "phys_dps", "mage_healer"];
  return order.map((id) => {
    const u = buildFromSpecies(byId[id], state.level, equip);
    u.image = byId[id].image;
    u.hp = Math.max(1, Math.round(u.maxHp * state.hpRatio[id]));
    return u;
  });
}

function saveHpRatio(party) {
  for (const u of party) state.hpRatio[u.id] = Math.max(0, u.hp / u.maxHp);
}

// 정해진 "보스 몬스터"가 따로 없다 — 아무 몬스터나 뽑아서 보스 배율(전체 스탯 위에 추가로 곱함)을 얹는 방식
function pickStageMonster(stageNum) {
  const isBoss = stageNum === STAGE_COUNT;
  const def = monstersData.monsters[Math.floor(Math.random() * monstersData.monsters.length)];
  const stageMult = 1 + (stageNum - 1) * config.perStageMultiplier; // D3: 지역 내 점진적 증가
  const totalMult = stageMult * (isBoss ? config.bossMultiplier : 1);
  const scaled = { ...def, multiplier: { ...def.multiplier }, isBoss };
  for (const k of Object.keys(scaled.multiplier)) scaled.multiplier[k] *= totalMult;
  if (isBoss) scaled.name = `${def.name} (보스)`;
  return scaled;
}

// ---------- 화면 전환 ----------
const screens = ["title", "town", "field", "battle"];
function showScreen(name) {
  for (const s of screens) document.getElementById(`screen-${s}`).style.display = s === name ? "block" : "none";
}

function renderTown() {
  document.getElementById("town-status").textContent =
    `Lv${state.level} · EXP ${state.exp} (다음 레벨까지 ${Math.max(0, statAtLevel(config.expCurve, Math.min(30, state.level + 1)) - state.exp)}) · 골드 ${state.gold}`;
}

function renderField() {
  const wrap = document.getElementById("field-stages");
  wrap.innerHTML = "";
  for (let i = 1; i <= STAGE_COUNT; i++) {
    const unlocked = i <= state.clearedStage + 1;
    const isBoss = i === STAGE_COUNT;
    const btn = document.createElement("button");
    btn.textContent = isBoss ? `${i}. 보스전` : `${i}. 전투`;
    btn.disabled = !unlocked;
    btn.style.margin = "4px";
    if (unlocked) btn.addEventListener("click", () => startBattle(i));
    wrap.appendChild(btn);
  }
}

// ---------- 전투 (포켓몬풍 화면) ----------
function hpBarClass(pct) {
  if (pct > 50) return "";
  if (pct > 20) return "yellow";
  return "red";
}

// 직전 행동(공격/회복) 정보 — 렌더링할 때 누가 때렸고 누가 맞았는지 판단해서 연출 클래스를 붙인다
let lastEvent = null;

function animClassFor(u) {
  if (!lastEvent) return "";
  if (lastEvent.attackerSide === u.side && lastEvent.attackerId === u.id) {
    return u.side === "player" ? "anim-attack-player" : "anim-attack-enemy";
  }
  if (lastEvent.targetSide === u.side && lastEvent.targetId === u.id) {
    if (lastEvent.type === "heal") return "anim-heal";
    if (lastEvent.type === "damage") return "anim-hit";
  }
  return "";
}

// 적: HP박스(이름/Lv/HP바)와 스프라이트를 따로 그린다 (포켓몬처럼 박스는 좌상단, 스프라이트는 우상단)
function renderEnemyBox(u) {
  const pct = Math.max(0, Math.round((u.hp / u.maxHp) * 100));
  return `
    <div class="poke-box ${u.alive ? "" : "dead"}">
      <div class="poke-name-row"><span>${u.name}</span><span>Lv${u.level}</span></div>
      <div class="poke-hp-label">HP</div>
      <div class="poke-hp-bar-bg"><div class="poke-hp-bar-fill ${hpBarClass(pct)}" style="width:${pct}%"></div></div>
      <div class="poke-hp-text">${u.hp} / ${u.maxHp}</div>
    </div>`;
}

function renderEnemySprite(u) {
  return `<div class="${animClassFor(u)}"><img src="${u.image}" alt="${u.name}" style="${u.alive ? "" : "opacity:0.3;"}" /></div>`;
}

// 파티: 스프라이트+HP박스를 한 카드로 묶어 하단에 가로로 배치
function renderPartyCard(u) {
  const pct = Math.max(0, Math.round((u.hp / u.maxHp) * 100));
  return `
    <div class="poke-box mon-card ${u.alive ? "" : "dead"} ${animClassFor(u)}">
      <img src="${u.image}" alt="${u.name}" />
      <div style="flex:1; min-width:0;">
        <div class="poke-name-row"><span>${u.name}</span><span>Lv${u.level}</span></div>
        <div class="poke-hp-label">HP</div>
        <div class="poke-hp-bar-bg"><div class="poke-hp-bar-fill ${hpBarClass(pct)}" style="width:${pct}%"></div></div>
        <div class="poke-hp-text">${u.hp} / ${u.maxHp}</div>
      </div>
    </div>`;
}

function renderBattlefield(party, enemies) {
  document.getElementById("enemy-boxes").innerHTML = enemies.map(renderEnemyBox).join("");
  document.getElementById("enemy-sprites").innerHTML = enemies.map(renderEnemySprite).join("");
  document.getElementById("party-row").innerHTML = party.map(renderPartyCard).join("");
}

function appendLog(line) {
  const logEl = document.getElementById("battle-log");
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
  document.getElementById("message-box").textContent = line;
}

let currentBattle = null;
let currentStageNum = null;

function startBattle(stageNum) {
  currentStageNum = stageNum;
  const party = buildParty();
  const monsterDef = pickStageMonster(stageNum);
  const enemy = buildFromMonster(monsterDef, monstersData.baseStats);
  enemy.image = monsterDef.image;

  document.getElementById("battle-log").textContent = "";
  document.getElementById("battle-result").textContent = "";
  document.getElementById("battle-next-btn").style.display = "none";
  document.getElementById("message-box").textContent = `야생의 ${enemy.name}이(가) 나타났다!`;
  lastEvent = null;
  renderBattlefield(party, [enemy]);
  showScreen("battle");

  currentBattle = new Battle({
    party, enemies: [enemy], config, elementsData, skillDefs,
    log: appendLog,
    onEvent: (ev) => { lastEvent = ev; },
  });

  // 한 턴이 눈에 충분히 보이도록 간격을 넉넉하게 둔다 (타격 애니메이션 0.5초 + 로그 읽는 시간)
  const TURN_INTERVAL_MS = 1400;
  const timer = setInterval(() => {
    const outcome = currentBattle.stepOnce();
    renderBattlefield(currentBattle.party, currentBattle.enemies);
    if (outcome) {
      clearInterval(timer);
      onBattleEnd(outcome, currentBattle.party, currentBattle.enemies, monsterDef);
    }
  }, TURN_INTERVAL_MS);
}

function onBattleEnd(outcome, party, enemies, monsterDef) {
  saveHpRatio(party);
  const resultEl = document.getElementById("battle-result");
  if (outcome.result === "승리") {
    const gainedExp = monsterDef.expReward;
    const gainedGold = monsterDef.gold;
    const prevLevel = state.level;
    state.exp += gainedExp;
    state.gold += gainedGold;
    state.level = levelFromExp(state.exp);
    if (currentStageNum > state.clearedStage) state.clearedStage = currentStageNum;
    let msg = `승리! (${outcome.turns}턴) EXP +${gainedExp}, 골드 +${gainedGold}`;
    if (state.level > prevLevel) msg += ` — 레벨 업! Lv${prevLevel} → Lv${state.level}`;
    if (currentStageNum === STAGE_COUNT) msg += " — 지역 클리어!";
    resultEl.textContent = msg;
    document.getElementById("message-box").textContent = "전투에서 승리했다!";
  } else {
    // 패배 시 체력만 1로 남기고(전멸 방지 데모) 마을로 돌아간다
    for (const id of Object.keys(state.hpRatio)) state.hpRatio[id] = 0.3;
    resultEl.textContent = `패배... (${outcome.turns}턴) 마을로 돌아갑니다.`;
    document.getElementById("message-box").textContent = "파티가 전멸했다...";
  }
  document.getElementById("battle-next-btn").style.display = "inline-block";
}

// ---------- 초기화 ----------
document.addEventListener("DOMContentLoaded", async () => {
  await loadData();
  document.getElementById("title-start-btn").addEventListener("click", () => {
    renderTown();
    showScreen("town");
  });
  document.getElementById("town-field-btn").addEventListener("click", () => {
    renderField();
    showScreen("field");
  });
  document.getElementById("town-inn-btn").addEventListener("click", () => {
    for (const id of Object.keys(state.hpRatio)) state.hpRatio[id] = 1;
    renderTown();
    alert("여관에서 파티 전원 체력을 회복했습니다. (무료 — 임시)");
  });
  document.getElementById("field-back-btn").addEventListener("click", () => showScreen("town"));
  document.getElementById("battle-next-btn").addEventListener("click", () => {
    renderTown();
    if (currentStageNum === STAGE_COUNT && state.clearedStage === STAGE_COUNT) {
      showScreen("town");
    } else {
      renderField();
      showScreen("field");
    }
  });
  showScreen("title");
});
