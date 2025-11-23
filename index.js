// index.js - Leaderboards message + vocal (weekly cycles) - SQLite version
// npm i discord.js better-sqlite3 dotenv
// .env: TOKEN, CLIENT_ID, OWNER_ID (optional), DB_PATH (optional)

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import Database from 'better-sqlite3';

// ---------- CONFIG ----------
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID || '1133246357960921158';
const DB_PATH = process.env.DB_PATH || './data.sqlite';

if (!TOKEN || !CLIENT_ID) {
  console.error('TOKEN and CLIENT_ID required in .env');
  process.exit(1);
}

const RESULTS_PER_PAGE = 10;
const LEADERBOARD_TOP = 10;
const DEBOUNCE_MS = 2000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000; // production weekly cycle
const TEST_MS = 4 * 60 * 1000; // 4 minutes test duration used by /setleaderboard

// ---------- DB init ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// users
db.prepare(`
CREATE TABLE IF NOT EXISTS users (
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  username TEXT,
  messages INTEGER DEFAULT 0,
  voiceSeconds INTEGER DEFAULT 0,
  voiceJoin INTEGER DEFAULT NULL,
  PRIMARY KEY (guildId, userId)
)`).run();

// leaderboards
// Added timerMessageId and winnersText columns (persist winners so they stay visible)
db.prepare(`
CREATE TABLE IF NOT EXISTS leaderboards (
  guildId TEXT NOT NULL,
  type TEXT NOT NULL,
  channelId TEXT NOT NULL,
  messageId TEXT,
  timerMessageId TEXT,
  startAt INTEGER,
  endAt INTEGER,
  winnersText TEXT,
  active INTEGER DEFAULT 1,
  PRIMARY KEY (guildId, type)
)`).run();

// If an older DB exists without the new columns, try to add them (safe no-op if column exists)
try { db.prepare(`ALTER TABLE leaderboards ADD COLUMN timerMessageId TEXT`).run(); } catch (e) {}
try { db.prepare(`ALTER TABLE leaderboards ADD COLUMN winnersText TEXT`).run(); } catch (e) {}

// prepared statements
const stmtUpsertUser = db.prepare(`
INSERT INTO users (guildId,userId,username) VALUES (@g,@u,@n)
ON CONFLICT(guildId,userId) DO UPDATE SET username = excluded.username
`);
const stmtIncMessage = db.prepare(`UPDATE users SET messages = messages + 1 WHERE guildId = @g AND userId = @u`);
const stmtGetTopMessages = db.prepare(`SELECT * FROM users WHERE guildId = ? ORDER BY messages DESC LIMIT ?`);
const stmtGetTopVoice = db.prepare(`SELECT * FROM users WHERE guildId = ? ORDER BY voiceSeconds DESC LIMIT ?`);
const stmtGetUser = db.prepare(`SELECT * FROM users WHERE guildId = ? AND userId = ?`);
const stmtAddVoiceSeconds = db.prepare(`UPDATE users SET voiceSeconds = voiceSeconds + @inc, voiceJoin = NULL WHERE guildId = @g AND userId = @u`);
const stmtSetVoiceJoin = db.prepare(`UPDATE users SET voiceJoin = @start WHERE guildId = @g AND userId = @u`);
const stmtGetLeaderboard = db.prepare(`SELECT * FROM leaderboards WHERE guildId = ? AND type = ?`);
const stmtUpsertLeaderboard = db.prepare(`
INSERT INTO leaderboards (guildId,type,channelId,messageId,timerMessageId,startAt,endAt,winnersText,active)
VALUES (@g,@t,@c,@m,@tm,@s,@e,@w,@a)
ON CONFLICT(guildId,type) DO UPDATE SET channelId=excluded.channelId, messageId=excluded.messageId, timerMessageId=excluded.timerMessageId, startAt=excluded.startAt, endAt=excluded.endAt, winnersText=excluded.winnersText, active=excluded.active
`);
const stmtGetAllLeaderboards = db.prepare(`SELECT * FROM leaderboards WHERE active = 1`);
const stmtUpdateLeaderboardMessage = db.prepare(`UPDATE leaderboards SET messageId = ? WHERE guildId = ? AND type = ?`);
const stmtUpdateTimerMessage = db.prepare(`UPDATE leaderboards SET timerMessageId = ? WHERE guildId = ? AND type = ?`);
const stmtUpdateWinnersText = db.prepare(`UPDATE leaderboards SET winnersText = ? WHERE guildId = ? AND type = ?`);
const stmtResetCountsMessages = db.prepare(`UPDATE users SET messages = 0 WHERE guildId = ?`);
const stmtResetCountsVoice = db.prepare(`UPDATE users SET voiceSeconds = 0, voiceJoin = NULL WHERE guildId = ?`);

// ---------- DISCORD CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

const activeVoice = new Map();
const pendingUpdate = new Map();

// ---------- UTILS ----------
function formatDHMS(totalSec) {
  totalSec = Math.max(0, Math.floor(totalSec));
  const days = Math.floor(totalSec / 86400);
  totalSec %= 86400;
  const hours = Math.floor(totalSec / 3600);
  totalSec %= 3600;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${days} jours, ${hours} heures, ${minutes} minutes, ${seconds} secondes`;
}
function fmtNumber(n) { return (n || 0).toLocaleString('en-US'); }

// style
const MEDALS = ['🥇','🥈','🥉'];
const COLOR_MARKERS = ['🏴','🏴','🏴','🏴','🏴','🏴','🏴','🏴','🏴','🏴'];

// ---------- SLASH COMMANDS ----------
const commands = [
  new SlashCommandBuilder()
    .setName('classement')
    .setDescription('Voir le classement vocal ou message')
    .addStringOption(opt => opt.setName('type').setDescription('message ou vocal').setRequired(true)
      .addChoices({ name:'message', value:'message' },{ name:'vocal', value:'vocal' })),
  new SlashCommandBuilder()
    .setName('setleaderboard')
    .setDescription('Configurer un salon pour leaderboard (owner only). Démarre le cycle (test 4min).')
    .addStringOption(opt => opt.setName('type').setDescription('message ou vocal').setRequired(true)
      .addChoices({ name:'message', value:'message' },{ name:'vocal', value:'vocal' }))
    .addChannelOption(opt => opt.setName('salon').setDescription('Salon de publication').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version:'10' }).setToken(TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Commands registered.');
  } catch (e) {
    console.error('Failed to register commands', e);
  }
})();

// ---------- READY ----------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.guilds.cache.forEach(guild => {
    guild.voiceStates.cache.forEach(state => {
      if (state.channel && !state.member.user.bot) {
        const key = `${guild.id}:${state.id}`;
        const row = stmtGetUser.get(guild.id, state.id);
        if (row && row.voiceJoin) {
          activeVoice.set(key, new Date(row.voiceJoin * 1000));  // FIX: multiply by 1000 to convert seconds to ms
        } else {
          const now = new Date();
          activeVoice.set(key, now);
          stmtUpsertUser.run({ g: guild.id, u: state.id, n: state.member.displayName || state.member.user.username });
          stmtSetVoiceJoin.run({ start: Math.floor(now.getTime()/1000), g: guild.id, u: state.id });
        }
      }
    });
  });

  // check expiry relatively often in test; production could be less frequent
  setInterval(processLeaderboardsExpiry, 15*1000);
  setInterval(() => {
    const rows = stmtGetAllLeaderboards.all();
    for (const r of rows) scheduleLeaderboardUpdate(r.guildId, r.type, 0);
  }, 30*1000);
});

// ---------- MESSAGE TRACKING ----------
client.on('messageCreate', msg => {
  if (!msg.guild || msg.author.bot) return;
  stmtUpsertUser.run({ g: msg.guild.id, u: msg.author.id, n: msg.member?.displayName || msg.author.username });
  stmtIncMessage.run({ g: msg.guild.id, u: msg.author.id });
  scheduleLeaderboardUpdate(msg.guild.id, 'message');
});

// ---------- VOICE TRACKING ----------
client.on('voiceStateUpdate', (o,n) => {
  if (n.member?.user.bot) return;
  const gid = n.guild.id;
  const uid = n.id;
  const key = `${gid}:${uid}`;

  if (!o.channel && n.channel) {
    const start = new Date();
    activeVoice.set(key, start);
    stmtUpsertUser.run({ g: gid, u: uid, n: n.member.displayName || n.member.user.username });
    stmtSetVoiceJoin.run({ start: Math.floor(start.getTime()/1000), g: gid, u: uid });
    scheduleLeaderboardUpdate(gid, 'vocal');
    return;
  }

  if (o.channel && n.channel && o.channelId !== n.channelId) {
    const start = activeVoice.get(key) || (o.joinedTimestamp ? new Date(o.joinedTimestamp) : null);
    if (start) {
      stmtAddVoiceSeconds.run({ inc: Math.floor((Date.now()-start.getTime())/1000), g: gid, u: uid });
    }
    const newStart = new Date();
    activeVoice.set(key, newStart);
    stmtSetVoiceJoin.run({ start: Math.floor(newStart.getTime()/1000), g: gid, u: uid });
    scheduleLeaderboardUpdate(gid, 'vocal');
    return;
  }

  if (o.channel && !n.channel) {
    const start = activeVoice.get(key) || (o.joinedTimestamp ? new Date(o.joinedTimestamp) : null);
    if (start) {
      stmtAddVoiceSeconds.run({ inc: Math.floor((Date.now()-start.getTime())/1000), g: gid, u: uid });
    }
    activeVoice.delete(key);
    stmtSetVoiceJoin.run({ start: null, g: gid, u: uid });
    scheduleLeaderboardUpdate(gid, 'vocal');
  }
});

// ---------- EMBEDS ----------
async function buildLeaderboardEmbed(guildId, type) {
  let rows = type === 'message'
    ? stmtGetTopMessages.all(guildId, 100)
    : stmtGetTopVoice.all(guildId, 100).map(r => {
        let total = r.voiceSeconds || 0;
        const key = `${guildId}:${r.userId}`;
        if (activeVoice.has(key)) total += Math.floor((Date.now()-activeVoice.get(key))/1000);
        else if (r.voiceJoin) total += Math.floor((Date.now()-r.voiceJoin*1000)/1000);
        return { ...r, totalSeconds: total };
      }).sort((a,b)=> (b.totalSeconds||0)-(a.totalSeconds||0));

  const slice = rows.slice(0, LEADERBOARD_TOP);

  const lines = slice.map((d,i)=>{
    const medal = i < 3 ? MEDALS[i] + ' ' : '▫️ ';
    const marker = COLOR_MARKERS[i % COLOR_MARKERS.length];
    if (type === 'message') return `• ${medal}${marker} <@${d.userId}> : \`${fmtNumber(d.messages)} messages\``;
    return `• ${medal}${marker} <@${d.userId}> : \`${formatDHMS(d.totalSeconds)}\``;
  });

  const description = lines.map(l => `${l}\n\n──────────`).join('\n').trim();

  const embed = new EmbedBuilder()
    .setTitle(type === 'message'
      ? '__**Statistiques Textuelles**__'
      : '__**Statistiques Vocal**__')
    .setDescription(description || 'Aucun résultat')
    .setColor(0x2f2b36)
    .setTimestamp();

  return { embed, rows };
}

async function buildConfiguredEmbed(gid, type) {
  const lb = stmtGetLeaderboard.get(gid, type);
  const { embed, rows } = await buildLeaderboardEmbed(gid, type);

  if (lb?.startAt && lb?.endAt) {
    const remainingMs = Math.max(0, lb.endAt - Date.now());
    const d = Math.floor(remainingMs / 86400000);
    const h = Math.floor((remainingMs % 86400000) / 3600000);
    const m = Math.floor((remainingMs % 3600000) / 60000);
    embed.setFooter({ text: `Fin du cycle dans : ${d} jours, ${h} heures, ${m} minutes — Top 3 sera récompensé` });
  } else {
    embed.setFooter({ text: 'Cycle non démarré' });
  }

  // append persisted winners text (Option A: winners remain visible H24)
  if (lb?.winnersText) {
    const base = embed.data.description || '';
    const appended = `${base}\n\n**Les vainqueurs de la semaine :**\n${lb.winnersText}`;
    embed.setDescription(appended);
  }

  return { embed, rows };
}

// ---------- UPDATE SCHEDULER ----------
function scheduleLeaderboardUpdate(g,t,d=DEBOUNCE_MS){
  const k = `${g}:${t}`;
  if (pendingUpdate.has(k)) clearTimeout(pendingUpdate.get(k));
  pendingUpdate.set(k, setTimeout(()=>doLeaderboardUpdate(g,t), d));
}

async function doLeaderboardUpdate(gid, type) {
  const cfg = stmtGetLeaderboard.get(gid, type);
  if (!cfg?.active) return;
  try {
    const ch = await client.channels.fetch(cfg.channelId).catch(()=>null);
    if (!ch?.isTextBased()) return;

    const { embed } = await buildConfiguredEmbed(gid, type);

    // **Note**: Timer message is NOT auto-updated (Option B). We only edit embed (and rely on Discord to show relative time properly).
    if (cfg.messageId) {
      const msg = await ch.messages.fetch(cfg.messageId).catch(()=>null);
      if (msg) return msg.edit({ embeds:[embed] });
    }

    const sent = await ch.send({ embeds:[embed] });
    stmtUpdateLeaderboardMessage.run(sent.id, gid, type);
  } catch(e){ console.error('doLeaderboardUpdate err', e); }
}

// ---------- EXPIRY + RESET ----------
async function processLeaderboardsExpiry(){
  const rows = stmtGetAllLeaderboards.all();
  for (const lb of rows){
    if (lb.endAt && Date.now() >= lb.endAt){
      await finalizeAndResetLeaderboard(lb.guildId, lb.type);
    }
  }
}

async function finalizeAndResetLeaderboard(gid, type) {
  const cfg = stmtGetLeaderboard.get(gid, type);
  if (!cfg) return;

  const ch = await client.channels.fetch(cfg.channelId).catch(()=>null);
  if (!ch?.isTextBased()) return;

  let rows = type === 'message'
    ? stmtGetTopMessages.all(gid, 100)
    : stmtGetTopVoice.all(gid, 100).map(r=>{
        let total=r.voiceSeconds||0;
        const k=`${gid}:${r.userId}`;
        if(activeVoice.has(k)) total+=Math.floor((Date.now()-activeVoice.get(k))/1000);
        else if(r.voiceJoin) total+=Math.floor((Date.now()-r.voiceJoin*1000)/1000);
        return {...r, totalSeconds:total};
      }).sort((a,b)=> (b.totalSeconds||0)-(a.totalSeconds||0));

  const top3 = rows.slice(0,3);
  const winnersLines = top3.map((d,i)=>{
    const m = MEDALS[i] || '•';
    if(type==='message') return `${m} <@${d.userId}> — \`${fmtNumber(d.messages)} messages\``;
    return `${m} <@${d.userId}> — \`${formatDHMS(d.totalSeconds)}\``;
  });

  // persist winners text so it remains visible (Option A)
  const winnersText = winnersLines.join('\n');
  stmtUpdateWinnersText.run(winnersText, gid, type);

  // re-build embed (it will now include persisted winnersText)
  const { embed } = await buildConfiguredEmbed(gid,type);

  if (cfg.messageId) {
    const msg = await ch.messages.fetch(cfg.messageId).catch(()=>null);
    if (msg) await msg.edit({ embeds:[embed] }).catch(()=>{});
    else {
      const s = await ch.send({ embeds:[embed] });
      stmtUpdateLeaderboardMessage.run(s.id,gid,type);
    }
  } else {
    const s = await ch.send({ embeds:[embed] });
    stmtUpdateLeaderboardMessage.run(s.id,gid,type);
  }

  // Reset counts (both types handled)
  if (type === 'message') stmtResetCountsMessages.run(gid);
  else stmtResetCountsVoice.run(gid);

  // Pour vocal, réinitialiser les timestamps actifs pour les sessions en cours
  if (type === 'vocal') {
    activeVoice.forEach((start, key) => {
      const [guildId, uid] = key.split(':');
      if (guildId === gid) {
        const now = new Date();
        activeVoice.set(key, now);  // Remettre le début à maintenant
        stmtSetVoiceJoin.run({ start: Math.floor(now.getTime() / 1000), g: guildId, u: uid });  // Mettre à jour la DB
      }
    });
  }

  // Start a new cycle immediately (production: WEEK_MS; we keep weekly restart)
  const startAt = Date.now();
  const endAt = startAt + WEEK_MS;
  stmtUpsertLeaderboard.run({ g:gid, t:type, c:cfg.channelId, m:cfg.messageId || null, tm: cfg.timerMessageId || null, s:startAt, e:endAt, w:winnersText, a:1 });

  // Update timer message with new timestamp (reprendre à zéro)
  if (cfg.timerMessageId) {
    const timerMsg = await ch.messages.fetch(cfg.timerMessageId).catch(()=>null);
    if (timerMsg) {
      const newUnix = Math.floor(endAt / 1000);
      await timerMsg.edit(`⏳ Le classement sera réinitialisé <t:${newUnix}:R>`).catch(e => console.error('Error updating timer message:', e));
    }
  }

  // schedule update (will show new countdown in footer)
  scheduleLeaderboardUpdate(gid,type,500);
}

// ---------- /classement pagination ----------
async function buildClassementPaginated(gid,type,page=1){
  let rows = type==='message'
    ? stmtGetTopMessages.all(gid,100)
    : stmtGetTopVoice.all(gid,100).map(r=>{
        let total=r.voiceSeconds||0;
        const k=`${gid}:${r.userId}`;
        if(activeVoice.has(k)) total+=Math.floor((Date.now()-activeVoice.get(k))/1000);
        else if(r.voiceJoin) total+=Math.floor((Date.now()-r.voiceJoin*1000)/1000);
        return {...r,totalSeconds:total};
      }).sort((a,b)=> (b.totalSeconds||0)-(a.totalSeconds||0));

  const pages = Math.max(1, Math.ceil(rows.length / RESULTS_PER_PAGE));
  const safe = Math.min(Math.max(1,page),pages);
  const start = (safe-1)*RESULTS_PER_PAGE;
  const slice = rows.slice(start,start+RESULTS_PER_PAGE);

  const lines = slice.map((d,i)=>{
    const index = start+i;
    const medal = index<3 ? MEDALS[index]+' ' : '▫️ ';
    const marker = COLOR_MARKERS[index % COLOR_MARKERS.length];
    if(type==='message') return `• ${medal}${marker} <@${d.userId}> : \`${fmtNumber(d.messages)} messages\``;
    return `• ${medal}${marker} <@${d.userId}> : \`${formatDHMS(d.totalSeconds)}\``;
  });

  const description = lines.map(l=>`${l}\n\n──────────`).join('\n').trim();

  const embed = new EmbedBuilder()
    .setTitle(type==='message'
      ? '__**Statistiques Textuelles**__'
      : '__**Statistiques Vocales**__')
    .setDescription(description || 'Aucun résultat')
    .setColor(0x2f2b36)
    .setFooter({ text:`Page ${safe}/${pages}` })
    .setTimestamp();

  return { embed, pages };
}

function makePageButtons(type,page,max){
  const row = new ActionRowBuilder();
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`classe_prev:${type}:${page}`)
      .setLabel('⬅️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page<=1),
    new ButtonBuilder()
      .setCustomId(`classe_next:${type}:${page}`)
      .setLabel('➡️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page>=max)
  );
  return row;
}

// ---------- INTERACTIONS ----------
client.on('interactionCreate', async interaction => {
  try {

    if (interaction.isChatInputCommand()) {

      // /classement
      if (interaction.commandName === 'classement') {
        const type = interaction.options.getString('type');
        await interaction.deferReply();
        const { embed, pages } = await buildClassementPaginated(interaction.guildId, type, 1);
        const row = makePageButtons(type,1,pages);
        return interaction.editReply({ embeds:[embed], components:[row] });
      }

      // /setleaderboard
      if (interaction.commandName === 'setleaderboard') {

        if (interaction.user.id !== OWNER_ID)
          return interaction.reply({ content:"❌ Vous n'avez pas la permission.", ephemeral:true });

        const type = interaction.options.getString('type');
        const ch = interaction.options.getChannel('salon');
        if (!ch || !ch.isTextBased())
          return interaction.reply({ content:'Salon invalide.', ephemeral:true });

        const startAt = Date.now();

        // TEST mode: 4 minutes as requested (production: use WEEK_MS)
        const endAt = startAt + TEST_MS;

        // upsert leaderboard config (winnersText left as null)
        stmtUpsertLeaderboard.run({
          g: interaction.guildId,
          t: type,
          c: ch.id,
          m: null,
          tm: null,
          s: startAt,
          e: endAt,
          w: null,
          a: 1
        });

        // ---- ADDED RESET MESSAGE (timestamp above embed) ----
        // Option B: send once and DO NOT auto-edit later
        const unix = Math.floor(endAt / 1000);
        const timerMsg = await ch.send(`⏳ Le classement sera réinitialisé <t:${unix}:R>`);
        // persist timer message id
        stmtUpdateTimerMessage.run(timerMsg.id, interaction.guildId, type);

        // send initial embed and persist
        const { embed } = await buildConfiguredEmbed(interaction.guildId, type);
        const sent = await ch.send({ embeds:[embed] });
        stmtUpdateLeaderboardMessage.run(sent.id, interaction.guildId, type);

        await interaction.reply({
          content: `✅ Leaderboard **${type}** configuré dans <#${ch.id}> (test 4 minutes).`,
          ephemeral: true
        });

        // Removed: scheduleLeaderboardUpdate(gid, type, 500); to avoid potential double update
        return;
      }
    }

    if (interaction.isButton()) {
      const parts = interaction.customId.split(':');
      if (parts.length === 3 && (parts[0].startsWith('classe_prev') || parts[0].startsWith('classe_next'))) {

        await interaction.deferUpdate();

        const type = parts[1];
        let page = parseInt(parts[2]);
        page = parts[0].includes('prev') ? Math.max(1,page-1) : page+1;

        const { embed, pages } = await buildClassementPaginated(interaction.guildId, type, page);
        const row = makePageButtons(type,page,pages);

        try { await interaction.message.edit({ embeds:[embed], components:[row] }); }
        catch {}
      }
    }

  } catch(e){
    console.error(e);
    if(!interaction.replied){
      interaction.reply({ content:'Erreur interne.', ephemeral:true }).catch(()=>{});
    }
  }
});

// ---------- START ----------
client.login(TOKEN).catch(e=>{
  console.error('Login failed', e);
  process.exit(1);
});
