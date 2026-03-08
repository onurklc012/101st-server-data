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
    const statusChannels = channels.filter(ch => {
        const name = ch.name.toLowerCase();
        return name.includes('server-') || name.includes('-dynamic');
    });

    console.log(`📡 Found ${statusChannels.length} server status channels`);
    const servers = [];

    for (const channel of statusChannels) {
        try {
            const messages = await discordGet(`/channels/${channel.id}/messages?limit=10`);
            const chName = channel.name.toLowerCase();
            let friendlyName;
            let mapId;

            if (chName.includes('-dynamic')) {
                // e.g. syria-dynamic or caucasus-dynamic
                const baseName = chName
                    .replace(/.*┃/g, '')
                    .replace(/[[\]（）［］\d\/／\s]/g, '')
                    .replace(/-dynamic.*/, '')
                    .trim();
                mapId = baseName;
                friendlyName = baseName.charAt(0).toUpperCase() + baseName.slice(1) + ' Dynamic';
            } else {
                // e.g. server-caucasus, server-syria
                const mapName = chName
                    .replace(/.*server-/i, '')
                    .replace(/[[\]（）［］\d\/／\s\-]/g, '')
                    .trim();
                mapId = mapName;
                friendlyName = mapName.charAt(0).toUpperCase() + mapName.slice(1);
            }

            const serverData = parseServerEmbeds(messages, channel.name);
            if (serverData) {
                serverData.mapId = mapId.toLowerCase();
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
            console.log(`    📋 Field: "${name}" → "${value.substring(0, 80).replace(/\n/g, ' | ')}${value.length > 80 ? '...' : ''}"`);

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
            } else if (name === 'Date / Time in Mission' || name.includes('Date') || name.includes('Runtime') || name.includes('Mission Time')) {
                const lines = value.split('\n');
                result.missionDate = lines[0].trim();
                // Try multiple patterns for runtime extraction
                const runtimePatterns = [
                    /\*{0,2}Runtime\*{0,2}[\s\S]*?([\d]+:[\d]+:?[\d]*)/i,
                    /Runtime[:\s]+(\d+:\d+(?::\d+)?)/i,
                    /(\d+:\d+:\d+)\s*$/m,
                    /(\d{1,3}:\d{2}:\d{2})/,
                    /(\d{1,3}:\d{2})/,
                ];
                for (const pat of runtimePatterns) {
                    const m = value.match(pat);
                    if (m) { result.runtime = m[1]; break; }
                }
                console.log(`    ⏱️ Date/Time field: "${value.replace(/\n/g, ' | ')}" → runtime: ${result.runtime}`);
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
            const lbDataList = parseLeaderboardMessages(messages, channel.name);
            for (const lb of lbDataList) {
                leaderboards.push(lb);
            }
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
    // Group embeds by their campaign title (Caucasus vs Syria etc.)
    const leaderboardMap = {};

    for (const msg of messages) {
        if (!msg.embeds) continue;
        for (const embed of msg.embeds) {
            const desc = embed.description || '';
            const embedTitle = embed.title || '';

            if (desc.includes('LEADERBOARD') || desc.includes('TOP') ||
                embedTitle.includes('LEADERBOARD') || embedTitle.includes('Leaderboard') ||
                desc.includes('credits') || desc.includes('#1')) {

                // Extract title to identify which server this belongs to
                let title = '';
                const titleMatch = desc.match(/🏆\s*(.+?)(?:\n|$)/);
                if (titleMatch) title = titleMatch[1].trim();
                if (!title && embedTitle) title = embedTitle;
                if (!title) title = 'Leaderboard';

                // Use title as key to group
                const key = title;
                if (!leaderboardMap[key]) {
                    leaderboardMap[key] = {
                        title,
                        pilots: [],
                        totalCredits: 0,
                        totalPlayers: 0,
                        activePilots: '',
                        highestScore: 0,
                        lastUpdate: null,
                    };
                }

                const lb = leaderboardMap[key];

                // Parse pilot entries
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
                            .replace(/\*+/g, '')
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

                        lb.pilots.push({ rank, name: pilotName, credits });
                    }
                }

                // Parse stats from fields
                if (embed.fields) {
                    for (const field of embed.fields) {
                        const fname = field.name.toLowerCase();
                        const fval = field.value.trim().replace(/```/g, '').trim();

                        if ((fname.includes('oyuncu') || fname.includes('player')) && (fname.includes('toplam') || fname.includes('total'))) {
                            const m = fval.match(/([\d,]+)/);
                            if (m) lb.totalPlayers = parseInt(m[1].replace(/,/g, ''));
                        } else if ((fname.includes('toplam') || fname.includes('total')) && (fname.includes('credit') || !fname.includes('oyuncu'))) {
                            const m = fval.match(/([\d,]+)/);
                            if (m) lb.totalCredits = parseInt(m[1].replace(/,/g, ''));
                        }
                        if (fname.includes('aktif') || fname.includes('active') || fname.includes('pilot')) {
                            lb.activePilots = fval;
                        }
                        if (fname.includes('yuksek') || fname.includes('highest') || fname.includes('puan') || fname.includes('score')) {
                            const m = fval.match(/([\d,]+)/);
                            if (m) lb.highestScore = parseInt(m[1].replace(/,/g, ''));
                        }
                    }
                }

                // Parse stats from description
                const totalMatch = desc.match(/Toplam\s*(?:Credits?)?[:\s]*([\d,]+)/i);
                if (totalMatch && !lb.totalCredits) lb.totalCredits = parseInt(totalMatch[1].replace(/,/g, ''));

                const activeMatch = desc.match(/(\d+\s*\/\s*\d+)/);
                if (activeMatch && !lb.activePilots) lb.activePilots = activeMatch[1];

                const highMatch = desc.match(/(?:En\s*Yuksek|Highest)\s*(?:Puan|Score)?[:\s]*([\d,]+)/i);
                if (highMatch && !lb.highestScore) lb.highestScore = parseInt(highMatch[1].replace(/,/g, ''));

                if (embed.footer?.text) lb.lastUpdate = embed.footer.text.replace(/10\s*dk/g, '5 dk');
            }
        }
    }

    // Convert map to array
    const results = [];
    for (const key of Object.keys(leaderboardMap)) {
        const lb = leaderboardMap[key];
        lb.pilots.sort((a, b) => a.rank - b.rank);

        if (!lb.totalCredits && lb.pilots.length > 0) lb.totalCredits = lb.pilots.reduce((sum, p) => sum + p.credits, 0);
        if (!lb.activePilots && lb.pilots.length > 0) lb.activePilots = String(lb.pilots.length);
        if (!lb.highestScore && lb.pilots.length > 0) lb.highestScore = Math.max(...lb.pilots.map(p => p.credits));

        results.push({
            channelName,
            title: lb.title || 'Leaderboard',
            pilots: lb.pilots,
            stats: {
                totalCredits: lb.totalCredits,
                totalPlayers: lb.totalPlayers || lb.pilots.length,
                activePilots: lb.activePilots,
                highestScore: lb.highestScore,
            },
            lastUpdate: lb.lastUpdate,
        });
    }

    return results;
}

// ─── Members ──────────────────────────────────────────

async function fetchMembers() {
    console.log('Fetching guild members...');

    // Fetch all guild roles
    const allRoles = await discordGet(`/guilds/${GUILD_ID}/roles`);
    const rolesMap = {};
    const rolesList = allRoles
        .filter(r => r.name !== '@everyone')
        .sort((a, b) => b.position - a.position)
        .map(r => {
            const obj = {
                id: r.id,
                name: r.name,
                color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null,
                icon: r.unicode_emoji || null,
                position: r.position,
            };
            rolesMap[r.id] = obj;
            return obj;
        });

    // Fetch members (paginated, up to 1000 per request)
    let allMembers = [];
    let after = '0';
    for (let i = 0; i < 10; i++) {
        const batch = await discordGet(`/guilds/${GUILD_ID}/members?limit=1000&after=${after}`);
        if (batch.length === 0) break;
        allMembers = allMembers.concat(batch);
        after = batch[batch.length - 1].user.id;
        if (batch.length < 1000) break;
    }
    console.log(`  Found ${allMembers.length} total members`);

    // Filter to 101 members only
    const filtered = allMembers.filter(m => {
        const name = m.nick || m.user.global_name || m.user.username || '';
        return name.includes('101') && !m.user.bot;
    });
    console.log(`  Filtered to ${filtered.length} 101 members`);

    // Build member list
    const memberList = filtered.map(m => {
        const memberRoles = (m.roles || [])
            .map(rid => rolesMap[rid])
            .filter(Boolean)
            .sort((a, b) => b.position - a.position);

        const topRole = memberRoles[0] || null;
        const avatarHash = m.user.avatar;
        const avatar = avatarHash
            ? `https://cdn.discordapp.com/avatars/${m.user.id}/${avatarHash}.png?size=128`
            : null;

        return {
            id: m.user.id,
            username: m.user.username,
            displayName: m.nick || m.user.global_name || m.user.username,
            avatar,
            roles: memberRoles,
            topRole: topRole ? { id: topRole.id, name: topRole.name, color: topRole.color, position: topRole.position } : null,
            joinedAt: m.joined_at || null,
            status: 'offline',
            activity: null,
        };
    }).sort((a, b) => {
        const aPos = a.topRole?.position || 0;
        const bPos = b.topRole?.position || 0;
        return bPos - aPos;
    });

    return {
        guildName: '101. HUNTER SQUADRON (AVCI FILOSU)',
        guildIcon: null,
        totalMembers: memberList.length,
        onlineCount: 0,
        members: memberList,
        roles: rolesList,
        lastUpdated: new Date().toISOString(),
        source: 'rest-api',
    };
}
// ─── Chat Messages ────────────────────────────────────

const CHAT_CHANNEL_PATTERNS = ['acedemy-mesaj', 'academy-mesaj', 'app-chat'];

async function fetchChatMessages(channels) {
    // First try exact pattern match (priority channels)
    let channel = channels.find(ch =>
        CHAT_CHANNEL_PATTERNS.some(p => ch.name.toLowerCase().includes(p))
    );

    // Fallback: try general chat channels
    if (!channel) {
        const fallbackPatterns = ['mesaj', 'genel', 'general', 'chat'];
        channel = channels.find(ch =>
            fallbackPatterns.some(p => ch.name.toLowerCase().includes(p))
        );
    }

    console.log(`💬 Chat channel: ${channel ? '#' + channel.name : 'not found'}`);

    if (!channel) {
        return { messages: [], channelName: null, lastUpdated: new Date().toISOString() };
    }

    try {
        const rawMessages = await discordGet(`/channels/${channel.id}/messages?limit=100`);

        // Parse messages — filter out bot embeds, keep text messages
        const messages = rawMessages
            .filter(msg => msg.content && msg.content.trim())
            .map(msg => {
                const avatarHash = msg.author.avatar;
                const avatar = avatarHash
                    ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${avatarHash}.png?size=64`
                    : null;

                return {
                    id: msg.id,
                    author: msg.author.global_name || msg.author.username,
                    authorId: msg.author.id,
                    avatar,
                    content: msg.content,
                    timestamp: msg.timestamp,
                    isBot: msg.author.bot || false,
                };
            })
            .reverse(); // oldest first

        console.log(`  ✅ Got ${messages.length} chat messages from #${channel.name}`);

        return {
            messages,
            channelId: channel.id,
            channelName: channel.name,
            lastUpdated: new Date().toISOString(),
        };
    } catch (err) {
        console.log(`  ⚠️ Could not read #${channel.name}: ${err.message}`);
        return { messages: [], channelName: channel.name, lastUpdated: new Date().toISOString() };
    }
}

// ─── Flight Hours ─────────────────────────────────────

const FLIGHT_HOURS_PATTERNS = ['flight-hours', 'ucus-saat', 'flight_hours'];

async function fetchFlightHours(channels) {
    // Also get ALL guild channels (flight-hours might not be type 0)
    let allChannels;
    try {
        allChannels = await discordGet(`/guilds/${GUILD_ID}/channels`);
    } catch (err) {
        console.log(`  ⚠️ Could not get all channels: ${err.message}`);
        allChannels = channels;
    }

    const fhChannels = allChannels.filter(ch =>
        FLIGHT_HOURS_PATTERNS.some(p => ch.name.toLowerCase().includes(p))
    );

    console.log(`✈️ Found ${fhChannels.length} flight hours channels`);
    if (fhChannels.length > 0) {
        fhChannels.forEach(ch => console.log(`  📡 ${ch.name} (type: ${ch.type}, id: ${ch.id})`));
    }
    if (fhChannels.length === 0) return null;

    for (const channel of fhChannels) {
        try {
            const messages = await discordGet(`/channels/${channel.id}/messages?limit=10`);
            const data = parseFlightHoursMessages(messages, channel.name);
            if (data) return data;
        } catch (err) {
            console.log(`  ⚠️ Could not read ${channel.name}: ${err.message}`);
        }
    }
    return null;
}

function parseFlightHoursMessages(messages, channelName) {
    console.log(`  🔍 Parsing ${messages.length} messages from ${channelName}`);
    for (const msg of messages) {
        if (!msg.embeds || msg.embeds.length === 0) continue;
        console.log(`  📃 Message has ${msg.embeds.length} embeds`);
        for (const embed of msg.embeds) {
            const title = embed.title || '';
            const desc = embed.description || '';
            const combined = title + ' ' + desc;

            console.log(`  📋 Embed title: "${title.substring(0, 80)}"`);
            console.log(`  📋 Embed desc length: ${desc.length}, first 80: "${desc.substring(0, 80)}"`);

            // Check if this embed is about flight hours (check BOTH title and description)
            const isFlightEmbed = combined.includes('Ucus') || combined.includes('ucus') ||
                combined.includes('Flight') || combined.includes('flight') ||
                combined.includes('saat') || combined.includes('Saat') ||
                desc.match(/\d+s\s+\d+dk/);

            if (!isFlightEmbed) {
                console.log(`  ⏭️ Skipping embed — no flight keywords found`);
                continue;
            }
            console.log(`  ✅ Found flight hours embed!`);

            const pilots = [];
            const lines = desc.split('\n');

            for (const line of lines) {
                // Match patterns like: 1. 101-Hunter[0101] | ✈️ 852s 17dk
                // or: 4. 101-Tunay [5555]      | 99s 54dk
                const match = line.match(/(\d+)\.\s*(.+?)\s*[|│┃]\s*(?:✈️\s*)?(?:🛩️\s*)?(\d+)s\s*(\d+)dk/);
                if (match) {
                    const rank = parseInt(match[1]);
                    const name = match[2].trim()
                        .replace(/\*\*(.+?)\*\*/g, '$1')
                        .replace(/\*(.+?)\*/g, '$1')
                        .replace(/\*+/g, '')
                        .trim();
                    const hours = parseInt(match[3]);
                    const minutes = parseInt(match[4]);
                    pilots.push({ rank, name, hours, minutes, totalMinutes: hours * 60 + minutes });
                }
            }

            if (pilots.length === 0) continue;

            // Parse stats from embed fields
            let totalFlightTime = null;
            let pilotCount = pilots.length;
            let totalKills = 0;
            let lastUpdate = null;

            if (embed.fields) {
                for (const field of embed.fields) {
                    const fname = field.name.toLowerCase();
                    const fval = field.value.trim().replace(/```/g, '').trim();

                    if (fname.includes('toplam') && fname.includes('ucus') || fname.includes('flight')) {
                        totalFlightTime = fval;
                    }
                    if (fname.includes('pilot') && fname.includes('sayisi') || fname.includes('count')) {
                        const m = fval.match(/(\d+)/);
                        if (m) pilotCount = parseInt(m[1]);
                    }
                    if (fname.includes('kill') || fname.includes('toplam kill')) {
                        const m = fval.match(/([\d,]+)/);
                        if (m) totalKills = parseInt(m[1].replace(/,/g, ''));
                    }
                }
            }

            // Also try to parse stats from description
            const totalFlightMatch = desc.match(/Toplam\s*Ucus[\s:]*([\d]+s\s*\d+dk)/i);
            if (totalFlightMatch && !totalFlightTime) totalFlightTime = totalFlightMatch[1];

            const pilotCountMatch = desc.match(/Pilot\s*Sayisi[\s:]*(\d+)/i);
            if (pilotCountMatch && !pilotCount) pilotCount = parseInt(pilotCountMatch[1]);

            const killMatch = desc.match(/Toplam\s*Kill[\s:]*([\d,]+)/i);
            if (killMatch && !totalKills) totalKills = parseInt(killMatch[1].replace(/,/g, ''));

            if (embed.footer?.text) lastUpdate = embed.footer.text;

            return {
                channelName,
                title: '101 Hunters SQN — Ucus Saatleri',
                pilots: pilots.sort((a, b) => a.rank - b.rank),
                stats: {
                    totalFlightTime: totalFlightTime || `${Math.floor(pilots.reduce((s, p) => s + p.totalMinutes, 0) / 60)}s ${pilots.reduce((s, p) => s + p.totalMinutes, 0) % 60}dk`,
                    pilotCount,
                    totalKills,
                },
                lastUpdate,
                lastUpdated: new Date().toISOString(),
            };
        }
    }
    return null;
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

    // Fetch members
    console.log('\n─── Members ───');
    let membersData = null;
    try {
        membersData = await fetchMembers();
        console.log(`  ✅ Got ${membersData.totalMembers} members`);
    } catch (err) {
        console.log(`  ⚠️ Members fetch failed: ${err.message}`);
    }

    // Fetch flight hours
    console.log('\n─── Flight Hours ───');
    let flightHoursData = null;
    try {
        flightHoursData = await fetchFlightHours(channels);
        if (flightHoursData) {
            console.log(`  ✅ Got flight hours: ${flightHoursData.pilots.length} pilots`);
        } else {
            console.log('  ⚠️ No flight hours data found');
        }
    } catch (err) {
        console.log(`  ⚠️ Flight hours fetch failed: ${err.message}`);
    }

    // Fetch chat messages
    console.log('\n─── Chat Messages ───');
    const chatData = await fetchChatMessages(channels);

    // Write JSON files
    writeFileSync('data/server-status.json', JSON.stringify(serverStatus, null, 2));
    writeFileSync('data/leaderboard.json', JSON.stringify(leaderboard, null, 2));
    if (membersData) {
        writeFileSync('data/members.json', JSON.stringify(membersData, null, 2));
    }
    if (flightHoursData) {
        writeFileSync('data/flight-hours.json', JSON.stringify(flightHoursData, null, 2));
    }
    writeFileSync('data/chat.json', JSON.stringify(chatData, null, 2));

    // Also write a combined status file
    const combined = {
        serverStatus,
        leaderboard,
        members: membersData,
        meta: {
            fetchedAt: new Date().toISOString(),
            source: 'GitHub Actions',
            refreshInterval: '10 minutes',
        }
    };
    writeFileSync('data/status.json', JSON.stringify(combined, null, 2));

    console.log('\n✅ Data written to data/ directory');
    console.log('  → data/server-status.json');
    console.log('  → data/leaderboard.json');
    if (membersData) console.log('  → data/members.json');
    if (flightHoursData) console.log('  → data/flight-hours.json');
    console.log('  → data/chat.json');
    console.log('  → data/status.json');
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
