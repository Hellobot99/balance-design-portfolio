// 전투 엔진 — RPG_설계결정서.xlsx B1~B7, C4, D1~D2 결정 반영
// 모든 실제 수치(species/monsters/skills/equipment/config.json)는 임시값. 밸런스 기획서에
// 실제 값이 채워지면 그 값으로 교체한다. 이 파일(계산 로직)은 값이 바뀌어도 재사용된다.

const LEVEL_STATS = ["HP", "ATK", "DEF", "속도", "힘", "지력", "치료효율"];

// C3: 값 = Lv1값 + (Lv30값-Lv1값) × ((1-k)×t + k×t³), t=(레벨-1)/29 — 1_스탯테이블과 동일 공식
function statAtLevel(anchor, level) {
  const t = (level - 1) / 29;
  const { lv1, lv30, k } = anchor;
  return Math.round(lv1 + (lv30 - lv1) * ((1 - k) * t + k * Math.pow(t, 3)));
}

function expForLevel(expCurve, level) {
  return statAtLevel(expCurve, level);
}

// C4: 레벨 4 : 장비 6 — 장비 보너스를 레벨 스탯에 더해서 최종 스탯을 만든다 (데모용 1슬롯)
function buildFromSpecies(species, level, equipment = null) {
  const stats = {};
  for (const s of LEVEL_STATS) stats[s] = statAtLevel(species.level[s], level);
  const fixed = { ...species.fixed };
  const equipped = equipment && equipment[species.id];
  if (equipped) {
    for (const [stat, amount] of Object.entries(equipped.bonus || {})) {
      stats[stat] = (stats[stat] || 0) + amount;
    }
    for (const [stat, amount] of Object.entries(equipped.fixedBonus || {})) {
      fixed[stat] = (fixed[stat] || 0) + amount;
    }
  }
  return {
    id: species.id,
    name: species.name,
    role: species.role,
    element: species.element,
    level,
    side: "player",
    stats,
    fixed,
    hp: stats.HP,
    maxHp: stats.HP,
    av: 10000 / stats["속도"],
    alive: true,
    cooldowns: {},
    buffs: [],
    equippedName: equipped ? equipped.name : null,
  };
}

function buildFromMonster(monsterDef, baseStats) {
  const stats = {};
  for (const s of LEVEL_STATS) {
    stats[s] = Math.round(baseStats[s] * (monsterDef.multiplier[s] ?? 1));
  }
  return {
    id: monsterDef.id,
    name: monsterDef.name,
    role: "monster",
    element: monsterDef.element,
    level: monsterDef.level,
    side: "enemy",
    stats,
    fixed: { 크리티컬확률: 0.05, 크리티컬피해: 0.5, 물리피해: 0, 마법피해: 0, 물리저항: 0.05, 마법저항: 0.05, 회피: 0.05 },
    hp: stats.HP,
    maxHp: stats.HP,
    av: 10000 / stats["속도"],
    alive: true,
    cooldowns: {},
    buffs: [],
    gold: monsterDef.gold,
  };
}

// 버프까지 반영한 실질 수치 (B5: 물리저항/마법저항도 버프로 임시 상승 가능)
function getEffectiveFixed(unit, statName) {
  let v = unit.fixed[statName] || 0;
  for (const b of unit.buffs) if (b.turnsLeft > 0 && b.stats.includes(statName)) v += b.amount;
  return v;
}

// B7: 약점 x1.5, 내성 x0.7
function elementalMultiplier(elementsData, attackerElement, defenderElement) {
  if (!attackerElement || !defenderElement) return 1.0;
  const { strongAgainst, weakMultiplier, resistMultiplier } = elementsData;
  if (strongAgainst[attackerElement] === defenderElement) return weakMultiplier;
  if (strongAgainst[defenderElement] === attackerElement) return resistMultiplier;
  return 1.0;
}

// B3: 원탁이론 — 회피 판정 → 치명타 판정 순서 (임시 우선순위)
function rollTable(rng, events) {
  const roll = rng();
  let acc = 0;
  for (const [name, prob] of events) {
    acc += prob;
    if (roll < acc) return name;
  }
  return "none";
}

// 공격력 = ATK×atk계수 + 힘×str계수 + 지력×int계수
// coefs를 안 주면 기본값: 물리 = ATK+힘, 마법 = ATK+지력. 스킬마다 coefs를 따로 정해서 이 비율을 바꿀 수 있다
// (예: 힘 계수를 0으로 빼고 ATK+지력만 반영하는 마법 스킬, 또는 힘+지력을 섞은 혼합형 스킬 등)
function attackPower(attacker, damageType, coefs) {
  const c = coefs || (damageType === "magical" ? { atk: 1, str: 0, int: 1 } : { atk: 1, str: 1, int: 0 });
  return attacker.stats.ATK * (c.atk ?? 1) + attacker.stats["힘"] * (c.str ?? 0) + attacker.stats["지력"] * (c.int ?? 0);
}

// B4(곱셈, 최소 대미지 없음) + B5(물리/마법 저항 분리) + B7(속성) + B1(물리피해/마법피해%, 크리티컬)
function computeDamage({ attacker, defender, config, elementsData, rng, damageType = "physical", coefs = null, multiplier = 1, ignoreEvade = false }) {
  const events = ignoreEvade
    ? [["치명타", attacker.fixed["크리티컬확률"]]]
    : [["회피", getEffectiveFixed(defender, "회피")], ["치명타", attacker.fixed["크리티컬확률"]]];
  const outcome = rollTable(rng, events);
  if (outcome === "회피") return { damage: 0, outcome };

  const K = config.defenseConstant;
  const defStat = getEffectiveFixed(defender, "DEF_PLACEHOLDER_UNUSED"); // no-op guard, DEF는 아래서 직접 참조
  const DEF = defender.stats.DEF + attackerBuffIgnore(defender); // DEF 자체에 버프 얹는 기능은 추후 필요시 확장
  const defMult = 1 - DEF / (DEF + K);

  const resKey = damageType === "magical" ? "마법저항" : "물리저항";
  const resMult = 1 - getEffectiveFixed(defender, resKey);

  const dmgBoostKey = damageType === "magical" ? "마법피해" : "물리피해";
  const dmgBoostMult = 1 + (attacker.fixed[dmgBoostKey] || 0);

  const elemMult = elementalMultiplier(elementsData, attacker.element, defender.element);
  const critMult = outcome === "치명타" ? 1 + attacker.fixed["크리티컬피해"] : 1;

  let dmg = attackPower(attacker, damageType, coefs) * multiplier * defMult * resMult * dmgBoostMult * elemMult * critMult;
  dmg = Math.max(0, Math.round(dmg));
  return { damage: dmg, outcome };
}
function attackerBuffIgnore() { return 0; } // DEF 버프는 아직 스킬에 없어 0 고정 (확장 지점)

function tickCooldowns(unit) {
  for (const id of Object.keys(unit.cooldowns)) {
    unit.cooldowns[id] = Math.max(0, unit.cooldowns[id] - 1);
  }
  for (const b of unit.buffs) b.turnsLeft -= 1;
  unit.buffs = unit.buffs.filter((b) => b.turnsLeft > 0);
}

function availableSkills(unit, skillDefs) {
  return (skillDefs[unit.id] || []).filter((s) => !unit.cooldowns[s.id]);
}

function applySkillEffect({ unit, skill, allies, enemies, config, elementsData, rng, log, onEvent = () => {} }) {
  const eff = skill.effect;
  if (eff.type === "damage") {
    const targets = unit.side === "player" ? enemies : allies;
    const target = targets.filter((u) => u.alive).sort((a, b) => a.hp - b.hp)[0];
    if (!target) return;
    const { damage, outcome } = computeDamage({
      attacker: unit, defender: target, config, elementsData, rng,
      damageType: eff.damageType || "physical", coefs: eff.coefs || null,
      multiplier: eff.multiplier || 1, ignoreEvade: !!eff.ignoreEvade,
    });
    target.hp = Math.max(0, target.hp - damage);
    log(`${unit.name} → [${skill.name}] → ${target.name} (${outcome}) ${damage} 대미지 [남은 HP ${target.hp}/${target.maxHp}]`);
    onEvent({ type: outcome === "회피" ? "miss" : "damage", attackerSide: unit.side, attackerId: unit.id, targetSide: target.side, targetId: target.id });
    if (target.hp <= 0) { target.alive = false; log(`${target.name} 쓰러짐`); }
  } else if (eff.type === "heal") {
    const woundedAlly = allies.filter((a) => a.alive).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
    if (!woundedAlly) return;
    const heal = Math.round(unit.stats["지력"] * eff.healRatio * (1 + (unit.fixed["치료효율"] || 0) / 100));
    woundedAlly.hp = Math.min(woundedAlly.maxHp, woundedAlly.hp + heal);
    log(`${unit.name} → [${skill.name}] → ${woundedAlly.name} 회복 ${heal} [HP ${woundedAlly.hp}/${woundedAlly.maxHp}]`);
    onEvent({ type: "heal", attackerSide: unit.side, attackerId: unit.id, targetSide: woundedAlly.side, targetId: woundedAlly.id });
  } else if (eff.type === "buff") {
    unit.buffs.push({ stats: eff.stats, amount: eff.amount, turnsLeft: eff.duration });
    log(`${unit.name} → [${skill.name}] 사용 (${eff.stats.join("/")} +${eff.amount} ${eff.duration}턴)`);
  }
  unit.cooldowns[skill.id] = skill.cooldown;
}

class Battle {
  constructor({ party, enemies, config, elementsData, skillDefs = { playerSkills: {}, monsterSkills: {} }, rng = Math.random, log = () => {}, onEvent = () => {} }) {
    this.party = party;
    this.enemies = enemies;
    this.config = config;
    this.elementsData = elementsData;
    this.skillDefs = skillDefs;
    this.rng = rng;
    this.log = log;
    this.onEvent = onEvent; // 연출용: {type:'damage'|'miss'|'heal', attackerSide, attackerId, targetSide, targetId}
    this.turnCount = 0;
  }

  aliveOf(list) { return list.filter((a) => a.alive); }

  pickActingUnit() {
    const all = [...this.aliveOf(this.party), ...this.aliveOf(this.enemies)];
    return all.reduce((min, u) => (u.av < min.av ? u : min), all[0]);
  }

  advanceTime(delta) {
    for (const u of [...this.party, ...this.enemies]) if (u.alive) u.av -= delta;
  }

  basicAttack(unit, target, damageType = "physical") {
    const { damage, outcome } = computeDamage({ attacker: unit, defender: target, config: this.config, elementsData: this.elementsData, rng: this.rng, damageType });
    target.hp = Math.max(0, target.hp - damage);
    this.log(`${unit.name} → ${target.name} 공격 (${outcome}) ${damage} 대미지 [남은 HP ${target.hp}/${target.maxHp}]`);
    this.onEvent({ type: outcome === "회피" ? "miss" : "damage", attackerSide: unit.side, attackerId: unit.id, targetSide: target.side, targetId: target.id });
    if (target.hp <= 0) { target.alive = false; this.log(`${target.name} 쓰러짐`); }
  }

  // D2: 몬스터 AI — 기본공격 + 쿨타임 돈 스킬 중 랜덤 선택
  act(unit) {
    this.turnCount++;
    tickCooldowns(unit);

    if (unit.side === "player") {
      const skills = availableSkills(unit, this.skillDefs.playerSkills);
      const woundedAlly = this.aliveOf(this.party).find((a) => a.hp / a.maxHp <= 0.5);

      if (unit.role === "마법딜러·힐러") {
        const healSkill = skills.find((s) => s.effect.type === "heal");
        const magicSkill = skills.find((s) => s.effect.type === "damage" && s.effect.damageType === "magical");
        if (woundedAlly && healSkill) {
          applySkillEffect({ unit, skill: healSkill, allies: this.party, enemies: this.enemies, config: this.config, elementsData: this.elementsData, rng: this.rng, log: this.log, onEvent: this.onEvent });
          return;
        }
        if (magicSkill) {
          applySkillEffect({ unit, skill: magicSkill, allies: this.party, enemies: this.enemies, config: this.config, elementsData: this.elementsData, rng: this.rng, log: this.log, onEvent: this.onEvent });
          return;
        }
        // 마법 스킬이 쿨타임이면 어쩔 수 없이 기본공격(물리, 힘 기반이라 약함)
        const target = this.aliveOf(this.enemies).sort((a, b) => a.hp - b.hp)[0];
        if (target) this.basicAttack(unit, target, "physical");
        return;
      }

      if (skills.length > 0) {
        applySkillEffect({ unit, skill: skills[0], allies: this.party, enemies: this.enemies, config: this.config, elementsData: this.elementsData, rng: this.rng, log: this.log, onEvent: this.onEvent });
        return;
      }
      const target = this.aliveOf(this.enemies).sort((a, b) => a.hp - b.hp)[0];
      if (target) this.basicAttack(unit, target, "physical");
    } else {
      const skills = availableSkills(unit, this.skillDefs.monsterSkills);
      const options = ["기본공격", ...skills.map((s) => s.name)];
      const choiceIdx = Math.floor(this.rng() * options.length);
      const target = this.aliveOf(this.party)[Math.floor(this.rng() * this.aliveOf(this.party).length)];
      if (!target) return;
      if (choiceIdx === 0) {
        this.basicAttack(unit, target, "physical");
      } else {
        const skill = skills[choiceIdx - 1];
        applySkillEffect({ unit, skill, allies: this.enemies, enemies: this.party, config: this.config, elementsData: this.elementsData, rng: this.rng, log: this.log, onEvent: this.onEvent });
      }
    }
  }

  isOver() {
    return this.aliveOf(this.party).length === 0 || this.aliveOf(this.enemies).length === 0;
  }

  outcome() {
    if (this.aliveOf(this.party).length === 0) return { result: "패배", turns: this.turnCount };
    if (this.aliveOf(this.enemies).length === 0) return { result: "승리", turns: this.turnCount };
    return null;
  }

  // 한 번에 한 유닛만 행동시킨다 (브라우저에서 턴 단위 애니메이션으로 보여줄 때 사용)
  stepOnce() {
    if (this.isOver()) return this.outcome();
    const actor = this.pickActingUnit();
    this.advanceTime(actor.av);
    this.act(actor);
    actor.av = 10000 / actor.stats["속도"];
    return this.isOver() ? this.outcome() : null;
  }

  run(maxTurns = 200) {
    while (this.turnCount < maxTurns) {
      const o = this.stepOnce();
      if (o) return o;
    }
    return { result: "시간초과(무승부)", turns: this.turnCount };
  }
}

if (typeof module !== "undefined") {
  module.exports = { statAtLevel, expForLevel, buildFromSpecies, buildFromMonster, elementalMultiplier, computeDamage, Battle, LEVEL_STATS };
}
