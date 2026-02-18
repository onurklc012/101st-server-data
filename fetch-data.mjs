/**
 * 101st Server Data Fetcher
 * 
 * Uses Discord REST API (no discord.js needed!) to:
 * 1. Read server status channels (server-*) for embed data
 * 2. Read leaderboard channels for pilot rankings
 * 3. Save results as JSON files in data/ directory
 * 
 * Runs via GitHub Actions cron every 10 minutes
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!BOT_TOKEN || !GUILD_ID) {
    console.error('❌ DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must be set');
    process.exit(1);
}

const API_BASE = 'https://discord.com/api/v10';
const headers = { Authorization: `Bot ${BOT_TOKEN}` };

// ─── Utility ──────────────────────────────────────────

async function discordGet(path) {
    const res = await fetch(`${API_BASE}${path}`, { headers });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Discord API ${res.status}: ${text}`);
    }
    return res.json();
}

// ─── Fetch all text channels ──────────────────────────

async function getTextChannels() {
    const channels = await discordGet(`/guilds/${GUILD_ID}/channels`);
    return channels.filter(ch => ch.type === 0); // 0 = text channel
}

// ─── Server Status ────────────────────────────────────

async function fetchServerStatus(channels) {
    const statusChannels = channels.filter(ch =>
        ch.name.toLowerCase().includes('server-')
    );

    console.log(`📡 Found ${statusChannels.length} server status channels`);
    const servers = [];

    for (const channel of statusChannels) {
        try {
            const messages = await discordGet(`/channels/${channel.id}/messages?limit=10`);
            const mapName = channel.name
                .replace(/.*server-/i, '')
                .replace(/[\[\]（）［］\d\/／\s\-]/g, '')
                .trim();
            const friendlyName = mapName.charAt(0).toUpperCase() + mapName.slice(1);

            const serverData = parseServerEmbeds(messages, channel.name);
            if (serverData) {
                serverData.mapId = mapName.toLowerCase();
                serverData.friendlyName = friendlyName;
                servers.push(serverData);
            }
        } catch (err) {
            console.log(`  ⚠️ Could not read ${channel.name}: ${err.message}`);
        }
    }

    return {
        servers,
        primaryServer: servers[0] || null,
        lastUpdated: new Date().toISOString(),
    };
}

function parseServerEmbeds(messages, channelName) {
    let serverInfo = null;
    let activePlayers = { blue: [], red: [], neutral: [] };
    let missionStats = null;

    for (const msg of messages) {
        if (!msg.embeds) continue;
        for (const embed of msg.embeds) {
            if (embed.description && embed.description.includes('Mission:')) {
                serverInfo = parseServerInfoEmbed(embed);
            } else if (embed.title === 'Active Players') {
                activePlayers = parseActivePlayersEmbed(embed);
            } else if (embed.title === 'Mission Statistics') {
                missionStats = parseMissionStatsEmbed(embed);
            }
        }
    }

    // Extract player count from channel name
    const channelCountMatch = channelName.match(/[\[［](\d+)[／\/](\d+)[\]］]/);
    const playersFromChannel = channelCountMatch ? parseInt(channelCountMatch[1]) : 0;
    const maxPlayersFromChannel = channelCountMatch ? parseInt(channelCountMatch[2]) : 32;

    const isOnline = serverInfo !== null;
    const playerList = [...activePlayers.blue, ...activePlayers.red, ...activePlayers.neutral];

    return {
        online: isOnline,
        channelName,
        serverName: serverInfo?.serverName || '101st Hunter Squadron',
        serverIP: serverInfo?.serverIP || null,
        mission: serverInfo?.mission || '--',
        map: serverInfo?.map || '--',
        players: playersFromChannel || playerList.length,
        maxPlayers: maxPlayersFromChannel,
        missionTime: serverInfo?.runtime || '--:--',
        missionDate: serverInfo?.missionDate || null,
        weather: serverInfo?.weather || null,
        slots: serverInfo?.slots || null,
        playerList: playerList.map(p => p.name),
        playerDetails: playerList,
        activePlayers,
        missionStats,
        lastUpdate: serverInfo?.lastUpdate || null,
    };
}

function parseServerInfoEmbed(embed) {
    const result = {
        mission: '--',
        serverName: '101st Hunter Squadron',
        serverIP: null,
        map: '--',
        runtime: '--:--',
        missionDate: null,
        weather: null,
        slots: null,
        lastUpdate: null,
    };

    const missionMatch = embed.description?.match(/Mission:\s*"?(.+?)"?$/m);
    if (missionMatch) result.mission = missionMatch[1].replace(/\\_/g, '_');

    if (embed.footer?.text) {
        const updateMatch = embed.footer.text.match(/Last updated:\s*(.+)/);
        if (updateMatch) result.lastUpdate = updateMatch[1].trim();
    }

    if (embed.fields) {
        for (const field of embed.fields) {
            const name = field.name.trim();
            const value = field.value.trim();

            if (name === 'Server-IP / Port') {
                result.serverIP = value;
            } else if (name === 'Map') {
                const lines = value.split('\n');
                result.map = lines[0].trim();
                const blueSlots = value.match(/🔹Used:\s*(\d+)\s*\/\s*(\d+)/);
                const redSlots = value.match(/🔸Used:\s*(\d+)\s*\/\s*(\d+)/);
                result.slots = {
                    blue: { used: blueSlots ? parseInt(blueSlots[1]) : 0, total: blueSlots ? parseInt(blueSlots[2]) : 0 },
                    red: { used: redSlots ? parseInt(redSlots[1]) : 0, total: redSlots ? parseInt(redSlots[2]) : 0 },
                };
            } else if (name === 'Date / Time in Mission') {
                const lines = value.split('\n');
                result.missionDate = lines[0].trim();
                const runtimeMatch = value.match(/\*{0,2}Runtime\*{0,2}[\n\r\s]+([\d]+:[\d]+:?[\d]*)/);
                if (runtimeMatch) result.runtime = runtimeMatch[1];
            } else if (name === 'Temperature') {
                const tempMatch = value.match(/([\d.]+)\s*°C/);
                const qnhMatch = value.match(/(\d+)\s*hPa/);
                result.weather = result.weather || {};
                result.weather.temperature = tempMatch ? tempMatch[1] + '°C' : '--';
                result.weather.qnh = qnhMatch ? qnhMatch[1] + ' hPa' : '--';
            } else if (name === 'Clouds') {
                result.weather = result.weather || {};
                const lines = value.split('\n').filter(l => l.trim() && !l.includes('Cloudbase'));
                result.weather.clouds = lines[0]?.trim() || '--';
                const baseMatch = value.match(/Cloudbase[\n\r]+([\d,]+)\s*ft/);
                result.weather.cloudbase = baseMatch ? baseMatch[1] + ' ft' : '--';
            } else if (name === 'Visibility') {
                result.weather = result.weather || {};
                const visLines = value.split('\n');
                result.weather.visibility = visLines[0]?.trim() || '--';
                const windMatch = value.match(/Ground:\s*(.+)/);
                result.weather.wind = windMatch ? windMatch[1].trim() : '--';
            }
        }
    }

    return result;
}

function parseActivePlayersEmbed(embed) {
    const result = { blue: [], red: [], neutral: [] };
    if (!embed.fields) return result;

    let currentSide = 'neutral';
    let namesList = [];
    let unitsList = [];

    for (const field of embed.fields) {
        const name = field.name.trim();
        const value = field.value.trim();

        if (name.includes('Blue') || value.includes('Blue')) {
            currentSide = 'blue';
            namesList = []; unitsList = [];
        } else if (name.includes('Red') || value.includes('Red')) {
            if (namesList.length > 0) {
                namesList.forEach((n, i) => {
                    result[currentSide].push({ name: n, unit: unitsList[i] || '--' });
                });
            }
            currentSide = 'red';
            namesList = []; unitsList = [];
        } else if (name.includes('Neutral')) {
            if (namesList.length > 0) {
                namesList.forEach((n, i) => {
                    result[currentSide].push({ name: n, unit: unitsList[i] || '--' });
                });
            }
            currentSide = 'neutral';
            namesList = []; unitsList = [];
        } else if (name === 'Name') {
            namesList = value.split('\n').map(s => s.trim()).filter(Boolean);
        } else if (name === 'Unit') {
            unitsList = value.split('\n').map(s => s.trim()).filter(Boolean);
        }
    }

    if (namesList.length > 0) {
        namesList.forEach((n, i) => {
            result[currentSide].push({ name: n, unit: unitsList[i] || '--' });
        });
    }

    return result;
}

function parseMissionStatsEmbed(embed) {
    if (!embed.fields) return null;

    const result = { situation: {}, achievements: {} };
    let section = 'situation';
    let labels = [];

    for (const field of embed.fields) {
        const name = field.name.trim();
        const value = field.value.trim();

        if (name.includes('Achievements')) {
            section = 'achievements';
            labels = [];
        } else if (name.includes('Current Situation')) {
            section = 'situation';
            labels = [];
        } else if (name === '_ _' && value !== '_ _') {
            labels = value.split('\n').map(s => s.trim()).filter(Boolean);
        } else if ((name === 'BLUE' || name === 'Blue') && labels.length > 0) {
            const values = value.split('\n').map(s => s.trim());
            labels.forEach((label, i) => {
                result[section][label] = result[section][label] || {};
                result[section][label].blue = parseInt(values[i]) || 0;
            });
        } else if ((name === 'RED' || name === 'Red') && labels.length > 0) {
            const values = value.split('\n').map(s => s.trim());
            labels.forEach((label, i) => {
                result[section][label] = result[section][label] || {};
                result[section][label].red = parseInt(values[i]) || 0;
            });
        }
    }

    return result;
}

// ─── Leaderboard ──────────────────────────────────────

const LEADERBOARD_PATTERNS = ['leaderboard', 'leader-board', 'stats', 'foothold'];

async function fetchLeaderboard(channels) {
    const lbChannels = channels.filter(ch =>
        LEADERBOARD_PATTERNS.some(p => ch.name.toLowerCase().includes(p))
    );

    console.log(`🏆 Found ${lbChannels.length} leaderboard channels`);
    const leaderboards = [];

    for (const channel of lbChannels) {
        try {
            const messages = await discordGet(`/channels/${channel.id}/messages?limit=50`);
            const lbData = parseLeaderboardMessages(messages, channel.name);
            if (lbData) leaderboards.push(lbData);
        } catch (err) {
            console.log(`  ⚠️ Could not read ${channel.name}: ${err.message}`);
        }
    }

    return {
        leaderboards,
        primary: leaderboards[0] || null,
        lastUpdated: new Date().toISOString(),
    };
}

function parseLeaderboardMessages(messages, channelName) {
    let title = '';
    let pilots = [];
    let totalCredits = 0;
    let totalPlayers = 0;
    let activePilots = '';
    let highestScore = 0;
    let lastUpdate = null;
    let found = false;

    for (const msg of messages) {
        if (!msg.embeds) continue;
        for (const embed of msg.embeds) {
            const desc = embed.description || '';
            const embedTitle = embed.title || '';

            if (desc.includes('LEADERBOARD') || desc.includes('TOP') ||
                embedTitle.includes('LEADERBOARD') || embedTitle.includes('Leaderboard') ||
                desc.includes('credits') || desc.includes('#1')) {
                found = true;

                const titleMatch = desc.match(/🏆\s*(.+?)(?:\n|$)/);
                if (titleMatch) title = titleMatch[1].trim();
                if (!title && embedTitle) title = embedTitle;

                const lines = desc.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const rankMatch = line.match(/#(\d+)\s*[|│┃]\s*(.+?)\s*$/);
                    if (rankMatch) {
                        const rank = parseInt(rankMatch[1]);
                        let pilotName = rankMatch[2].trim()
                            .replace(/\*\*(.+?)\*\*/g, '$1')
                            .replace(/__(.+?)__/g, '$1')
                            .replace(/\*(.+?)\*/g, '$1')
                            .replace(/~~(.+?)~~/g, '$1')
                            .replace(/`(.+?)`/g, '$1')
                            .replace(/\*+/g, '')  // strip any remaining asterisks
                            .trim();

                        let credits = 0;
                        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                            const cleanLine = lines[j].replace(/\*\*/g, '').replace(/__/g, '');
                            const creditMatch = cleanLine.match(/([\d,]+)\s*credits?/i);
                            if (creditMatch) {
                                credits = parseInt(creditMatch[1].replace(/,/g, ''));
                                break;
                            }
                            const numMatch = cleanLine.match(/([\d,]{3,})/);
                            if (numMatch && !cleanLine.includes('#')) {
                                credits = parseInt(numMatch[1].replace(/,/g, ''));
                                break;
                            }
                        }

                        pilots.push({ rank, name: pilotName, credits });
                    }
                }

                if (embed.fields) {
                    for (const field of embed.fields) {
                        const fname = field.name.toLowerCase();
                        const fval = field.value.trim().replace(/```/g, '').trim();

                        if ((fname.includes('oyuncu') || fname.includes('player')) && (fname.includes('toplam') || fname.includes('total'))) {
                            const m = fval.match(/([\d,]+)/);
                            if (m) totalPlayers = parseInt(m[1].replace(/,/g, ''));
                        } else if ((fname.includes('toplam') || fname.includes('total')) && (fname.includes('credit') || !fname.includes('oyuncu'))) {
                            const m = fval.match(/([\d,]+)/);
                            if (m) totalCredits = parseInt(m[1].replace(/,/g, ''));
                        }
                        if (fname.includes('aktif') || fname.includes('active') || fname.includes('pilot')) {
                            activePilots = fval;
                        }
                        if (fname.includes('yuksek') || fname.includes('highest') || fname.includes('puan') || fname.includes('score')) {
                            const m = fval.match(/([\d,]+)/);
                            if (m) highestScore = parseInt(m[1].replace(/,/g, ''));
                        }
                    }
                }

                const totalMatch = desc.match(/Toplam\s*(?:Credits?)?[:\s]*([\d,]+)/i);
                if (totalMatch && !totalCredits) totalCredits = parseInt(totalMatch[1].replace(/,/g, ''));

                const activeMatch = desc.match(/(\d+\s*\/\s*\d+)/);
                if (activeMatch && !activePilots) activePilots = activeMatch[1];

                const highMatch = desc.match(/(?:En\s*Yuksek|Highest)\s*(?:Puan|Score)?[:\s]*([\d,]+)/i);
                if (highMatch && !highestScore) highestScore = parseInt(highMatch[1].replace(/,/g, ''));

                if (embed.footer?.text) lastUpdate = embed.footer.text.replace(/10\s*dk/g, '5 dk');
            }
        }
    }

    if (!found) return null;

    pilots.sort((a, b) => a.rank - b.rank);

    if (!totalCredits && pilots.length > 0) totalCredits = pilots.reduce((sum, p) => sum + p.credits, 0);
    if (!activePilots && pilots.length > 0) activePilots = String(pilots.length);
    if (!highestScore && pilots.length > 0) highestScore = Math.max(...pilots.map(p => p.credits));

    return {
        channelName,
        title: title || 'Leaderboard',
        pilots,
        stats: { totalCredits, totalPlayers: totalPlayers || pilots.length, activePilots, highestScore },
        lastUpdate,
    };
}




// ─── Main ─────────────────────────────────────────────

async function main() {
    console.log('🚀 101st Server Data Fetcher');
    console.log(`📅 ${new Date().toISOString()}\n`);

    // Ensure data directory exists
    if (!existsSync('data')) mkdirSync('data');

    // Get all text channels
    const channels = await getTextChannels();
    console.log(`📋 Found ${channels.length} text channels in guild\n`);

    // Fetch server status
    console.log('─── Server Status ───');
    const serverStatus = await fetchServerStatus(channels);
    console.log(`  ✅ Got ${serverStatus.servers.length} servers`);
    for (const s of serverStatus.servers) {
        console.log(`    ${s.online ? '🟢' : '🔴'} ${s.friendlyName || s.map} — ${s.players}/${s.maxPlayers} players`);
    }

    // Fetch leaderboard
    console.log('\n─── Leaderboard ───');
    const leaderboard = await fetchLeaderboard(channels);
    if (leaderboard.primary) {
        console.log(`  ✅ Got leaderboard: ${leaderboard.primary.pilots.length} pilots`);
    } else {
        console.log('  ⚠️ No leaderboard data found');
    }

    
    // Fetch Discord members
    console.log('\n─── Discord Members ───');
    const membersData = await fetchDiscordMembers();
    console.log(`  ✅ Got ${membersData.members.length} members`);

    // Write JSON files
    writeFileSync('data/server-status.json', JSON.stringify(serverStatus, null, 2));
    writeFileSync('data/leaderboard.json', JSON.stringify(leaderboard, null, 2));
    
    // Also write a combined status file
    const combined = {
        serverStatus,
        leaderboard,
        meta: {
            fetchedAt: new Date().toISOString(),
            source: 'GitHub Actions',
            refreshInterval: '5 minutes',
        }
    };
    writeFileSync('data/status.json', JSON.stringify(combined, null, 2));

    console.log('\n✅ Data written to data/ directory');
    console.log('  → data/server-status.json');
    console.log('  → data/leaderboard.json');
    console.log('  → data/status.json');
    }

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
