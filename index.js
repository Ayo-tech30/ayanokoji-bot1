// AYANOKOJI WHATSAPP BOT - TELEGRAM HOSTED VERSION
// Created by: Isagi Yoichi
// Control via Telegram, runs on WhatsApp

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeInMemoryStore, jidDecode, proto, getContentType, downloadMediaMessage } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Boom } = require('@hapi/boom');

// TELEGRAM BOT CONFIGURATION
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || 'YOUR_TELEGRAM_ID';
const telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Database using JSON files
const DATA_DIR = './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Helper functions for database
const loadDB = (file) => {
    const filePath = path.join(DATA_DIR, file);
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify({}));
        return {};
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const saveDB = (file, data) => {
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
};

// Database files
let users = loadDB('users.json');
let groups = loadDB('groups.json');
let cards = loadDB('cards.json');
let botStats = {
    startTime: Date.now(),
    messagesProcessed: 0,
    commandsExecuted: 0,
    activeUsers: 0,
    activeGroups: 0
};

// Save databases periodically
setInterval(() => {
    saveDB('users.json', users);
    saveDB('groups.json', groups);
    saveDB('cards.json', cards);
}, 60000);

// Initialize user data
const initUser = (userId) => {
    if (!users[userId]) {
        users[userId] = {
            name: '',
            bio: '',
            age: 0,
            balance: 1000,
            bank: 0,
            inventory: {},
            cards: [],
            lastDaily: 0,
            lastDig: 0,
            lastFish: 0,
            warns: 0,
            xp: 0,
            level: 1
        };
    }
    return users[userId];
};

// Initialize group data
const initGroup = (groupId) => {
    if (!groups[groupId]) {
        groups[groupId] = {
            antilink: false,
            antilinkAction: 'warn',
            antism: false,
            welcome: false,
            leave: false,
            welcomeMsg: 'Welcome @user to the group!',
            leaveMsg: 'Goodbye @user!',
            muted: [],
            blacklist: []
        };
    }
    return groups[groupId];
};

// Bot configuration
const PREFIX = '.';
const OWNER_NUMBER = '2349049460676@s.whatsapp.net';

let whatsappBot = null;
let connectionStatus = 'Disconnected';

// Send notification to Telegram
const notifyTelegram = (message) => {
    try {
        telegramBot.sendMessage(ADMIN_TELEGRAM_ID, message, { parse_mode: 'HTML' });
    } catch (error) {
        console.error('Telegram notification failed:', error);
    }
};

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['Ayanokoji Bot', 'Chrome', '3.0'],
        getMessage: async (key) => {
            return { conversation: 'Hi' };
        }
    });

    whatsappBot = sock;

    // Pairing code function
    if (!sock.authState.creds.registered) {
        const phoneNumber = '2349049460676';
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`🔐 PAIRING CODE: ${code}`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
        
        notifyTelegram(`
🔐 <b>PAIRING CODE GENERATED</b>

Code: <code>${code}</code>

⚡ Open WhatsApp → Settings → Linked Devices → Link with Phone Number
⚡ Enter this code to connect!

Valid for: 1 minute
        `);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            connectionStatus = 'Disconnected';
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting...', shouldReconnect);
            notifyTelegram('❌ <b>Bot Disconnected!</b>\n\nAttempting to reconnect...');
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            connectionStatus = 'Connected';
            console.log('✅ Bot Connected Successfully!');
            notifyTelegram(`
✅ <b>BOT CONNECTED SUCCESSFULLY!</b>

🤖 Ayanokoji is now online!
📱 WhatsApp: +234 904 946 0676
⏰ Time: ${new Date().toLocaleString()}

Ready to serve! 🚀
            `);
        } else if (connection === 'connecting') {
            connectionStatus = 'Connecting...';
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        botStats.messagesProcessed++;
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const sender = isGroup ? msg.key.participant : from;
        const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const args = body.trim().split(/ +/);
        const command = args[0].toLowerCase();

        // Update stats
        botStats.activeUsers = Object.keys(users).length;
        botStats.activeGroups = Object.keys(groups).length;

        // Initialize user
        const user = initUser(sender);
        
        // Initialize group if in group
        if (isGroup) initGroup(from);

        // Reply helper
        const reply = (text) => sock.sendMessage(from, { text }, { quoted: msg });
        const sendImage = async (imageUrl, caption) => {
            try {
                const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
                await sock.sendMessage(from, { image: Buffer.from(response.data), caption }, { quoted: msg });
            } catch (e) {
                reply('Failed to send image.');
            }
        };

        // Log commands to Telegram
        if (command.startsWith(PREFIX)) {
            botStats.commandsExecuted++;
            const senderName = user.name || sender.split('@')[0];
            notifyTelegram(`
📝 <b>Command Executed</b>

User: ${senderName}
Command: <code>${command}</code>
Group: ${isGroup ? 'Yes' : 'No'}
            `);
        }

        // MENU COMMAND
        if (command === PREFIX + 'menu') {
            const menuText = `╭━━ ✦彡  𝙉 𝙀 𝙓 𝙊 𝙍 𝘼  彡✦ ━━╮     
║  ✧ Name: Ayanokoji 
║  ✧ Prefix  : ${PREFIX}   
║  ✧ Creator : 𝑰𝒔𝒂𝒈𝒊 𝒀𝒐𝒊𝒄𝒉𝒊
╰━━━━━━━━━━━━━━━━━━━╯
 ❖ *.support* official group

╓─── ◈ BASIC ACCESS ◈ ───╖
║ ◇ .profile / p
║ ◇ .edit
║ ◇ .bio
║ ◇ .setage
║ ◇ .inventory / inv
╟── ◈ ECONOMY CORE ◈ ──╢
║ ◆ .bal
║ ◆ .daily
║ ◆ .wd
║ ◆ .dep
║ ◆ .donate
║ ◆ .lottery
║ ◆ .rich
║ ◆ .richg
║ ◆ .shop
║ ◆ .use
║ ◆ .sell
║ ◆ .dig
║ ◆ .fish
║ ◆ .lb
║ ◆ .gamble
║ ◆ .beg
║ ◆ .roast
╟── ◈ CARD SYSTEM ◈ ──╢
║ ◈ .cards
║ ◈ .card
║ ◈ .ci
║ ◈ .cardinfo
║ ◈ .si
║ ◈ .ss
║ ◈ .slb
║ ◈ .clb
║ ◈ .deck
║ ◈ .col
║ ◈ .cardshop
║ ◈ .sellc
║ ◈ .rc
║ ◈ .claim
║ ◈ .vs
║ ◈ .sc
║ ◈ .tc
║ ◈ .lendcard / lc
║ ◈ .auction
║ ◈ .submit
║ ◈ .myauc
║ ◈ .remauc
║ ◈ .listauc
╟── ◈ GAME ZONE ◈ ──╢
║ ▸ .ttt
║ ▸ .startbattle
║ ▸ .akinator / aki
║ ▸ .greekgod / gg
║ ▸ .c4
║ ▸ .wcg
║ ▸ .chess
╟── ◈ CASINO & RISK ◈ ──╢
║ ◇ .slots
║ ◇ .cf
║ ◇ .dice
║ ◇ .db
║ ◇ .dp
║ ◇ .roulette
║ ◇ .horse
╟── ◈ INTERACTION ◈ ──╢
║ ✦ .hug
║ ✦ .kiss
║ ✦ .slap
║ ✦ .wave
║ ✦ .pat
║ ✦ .dance
║ ✦ .sad
║ ✦ .smile
║ ✦ .laugh
║ ✦ .lick
║ ✦ .punch
║ ✦ .kill
║ ✦ .bonk
║ ✦ .tickle
║ ✦ .shrug
║ ✦ .wank
║ ✦ .kidnap
╟── ◈ FUN & CHAOS ◈ ──╢
║ • .gay
║ • .lesbian
║ • .simp
║ • .ship
║ • .skill
║ • .duality
║ • .gen
║ • .pov
║ • .social
║ • .relation
║ • .pp
║ • .wouldyourather / wyr
║ • .joke
║ • .truth
║ • .dare
║ • .td
║ • .uno
╟── ◈ DOWNLOAD HUB ◈ ──╢
║ ◦ .ig
║ ◦ .ttk
║ ◦ .yt
║ ◦ .x
║ ◦ .fb
║ ◦ .play
╟── ◈ SEARCH & TOOLS ◈ ──╢
║ ↳ .pinterest / pint
║ ↳ .sauce / reverseimg
║ ↳ .wallpaper
║ ↳ .lyrics
╟── ◈ AI SUITE ◈ ──╢
║ ▣ .copilot
║ ▣ .gpt
║ ▣ .perplexity
║ ▣ .imagine
║ ▣ .upscale
║ ▣ .translate / tt
║ ▣ .transcribe / tb
╟── ◈ MEDIA CONVERT ◈ ──╢
║ ◈ .sticker / s
║ ◈ .take
║ ◈ .toimg
║ ◈ .tovid
║ ◈ .rotate
╟── ◈ ANIME ZONE ◈ ──╢
║ 🌸 .waifu
║ 🌸 .neko
║ 🌸 .maid
║ 🌸 .oppai
║ 🌸 .selfies
║ 🌸 .uniform
║ 🌸 .mori-calliope
║ 🌸 .raiden-shogun
║ 🌸 .kamisato-ayaka
║ 🔞 .nsfw on/off
║ 🔞 .milf
║ 🔞 .ass
║ 🔞 .hentai
║ 🔞 .oral
║ 🔞 .ecchi
║ 🔞 .paizuri
║ 🔞 .ero
║ 🔞 .ehentai
║ 🔞 .nhentai
╟── ◈ ADMIN CONTROL ◈ ──╢
║ ■ .kick
║ ■ .delete
║ ■ .antilink
║ ■ .antilink action
║ ■ .antism on/off
║ ■ .warn
║ ■ .resetwarn
║ ■ .groupstats / gs
║ ■ .welcome on/off
║ ■ .setwelcome
║ ■ .leave on/off
║ ■ .setleave
║ ■ .purge
║ ■ .blacklist
║ ■ .promote
║ ■ .demote
║ ■ .mute
║ ■ .unmute
║ ■ .hidetag
║ ■ .tagall
║ ■ .activity
║ ■ .active
║ ■ .inactive
║ ■ .open
║ ■ .close`;

            await sock.sendMessage(from, { 
                image: { url: 'https://i.pinimg.com/736x/79/a5/3d/79a53dd17e93c6e564b78d2aa28f1ca0.jpg' },
                caption: menuText 
            }, { quoted: msg });
        }

        // BASIC ACCESS COMMANDS
        else if (command === PREFIX + 'profile' || command === PREFIX + 'p') {
            reply(`👤 *PROFILE*\n\n` +
                  `Name: ${user.name || 'Not set'}\n` +
                  `Bio: ${user.bio || 'Not set'}\n` +
                  `Age: ${user.age || 'Not set'}\n` +
                  `Level: ${user.level}\n` +
                  `XP: ${user.xp}\n` +
                  `Balance: $${user.balance}\n` +
                  `Bank: $${user.bank}`);
        }

        else if (command === PREFIX + 'edit') {
            if (!args[1]) return reply('Usage: .edit <name>');
            user.name = args.slice(1).join(' ');
            reply(`✅ Name updated to: ${user.name}`);
        }

        else if (command === PREFIX + 'bio') {
            if (!args[1]) return reply('Usage: .bio <your bio>');
            user.bio = args.slice(1).join(' ');
            reply(`✅ Bio updated!`);
        }

        else if (command === PREFIX + 'setage') {
            const age = parseInt(args[1]);
            if (!age || age < 1 || age > 120) return reply('Please provide a valid age (1-120)');
            user.age = age;
            reply(`✅ Age set to: ${age}`);
        }

        else if (command === PREFIX + 'inventory' || command === PREFIX + 'inv') {
            const inv = user.inventory;
            if (Object.keys(inv).length === 0) return reply('Your inventory is empty!');
            let text = '🎒 *INVENTORY*\n\n';
            for (let item in inv) {
                text += `${item}: ${inv[item]}\n`;
            }
            reply(text);
        }

        // ECONOMY COMMANDS
        else if (command === PREFIX + 'bal') {
            reply(`💰 *BALANCE*\n\nWallet: $${user.balance}\nBank: $${user.bank}\nTotal: $${user.balance + user.bank}`);
        }

        else if (command === PREFIX + 'daily') {
            const now = Date.now();
            const cooldown = 24 * 60 * 60 * 1000;
            if (now - user.lastDaily < cooldown) {
                const timeLeft = cooldown - (now - user.lastDaily);
                const hours = Math.floor(timeLeft / (60 * 60 * 1000));
                return reply(`⏰ You already claimed your daily! Come back in ${hours} hours.`);
            }
            const reward = Math.floor(Math.random() * 500) + 500;
            user.balance += reward;
            user.lastDaily = now;
            reply(`✅ Daily claimed! You received $${reward}`);
        }

        else if (command === PREFIX + 'wd') {
            const amount = parseInt(args[1]);
            if (!amount || amount < 1) return reply('Usage: .wd <amount>');
            if (user.bank < amount) return reply('Insufficient bank balance!');
            user.bank -= amount;
            user.balance += amount;
            reply(`✅ Withdrew $${amount} from bank`);
        }

        else if (command === PREFIX + 'dep') {
            const amount = parseInt(args[1]);
            if (!amount || amount < 1) return reply('Usage: .dep <amount>');
            if (user.balance < amount) return reply('Insufficient balance!');
            user.balance -= amount;
            user.bank += amount;
            reply(`✅ Deposited $${amount} to bank`);
        }

        else if (command === PREFIX + 'gamble') {
            const amount = parseInt(args[1]);
            if (!amount || amount < 1) return reply('Usage: .gamble <amount>');
            if (user.balance < amount) return reply('Insufficient balance!');
            const win = Math.random() > 0.5;
            if (win) {
                user.balance += amount;
                reply(`🎰 You won $${amount}!`);
            } else {
                user.balance -= amount;
                reply(`💸 You lost $${amount}!`);
            }
        }

        else if (command === PREFIX + 'dig') {
            const now = Date.now();
            const cooldown = 60 * 1000;
            if (now - user.lastDig < cooldown) return reply('⏰ Cooldown! Wait 1 minute.');
            const reward = Math.floor(Math.random() * 100) + 50;
            user.balance += reward;
            user.lastDig = now;
            reply(`⛏️ You dug and found $${reward}!`);
        }

        else if (command === PREFIX + 'fish') {
            const now = Date.now();
            const cooldown = 60 * 1000;
            if (now - user.lastFish < cooldown) return reply('⏰ Cooldown! Wait 1 minute.');
            const reward = Math.floor(Math.random() * 150) + 100;
            user.balance += reward;
            user.lastFish = now;
            reply(`🎣 You caught a fish worth $${reward}!`);
        }

        else if (command === PREFIX + 'beg') {
            const reward = Math.floor(Math.random() * 50) + 10;
            user.balance += reward;
            reply(`🥺 Someone gave you $${reward}!`);
        }

        else if (command === PREFIX + 'lb') {
            const sorted = Object.entries(users).sort((a, b) => (b[1].balance + b[1].bank) - (a[1].balance + a[1].bank)).slice(0, 10);
            let text = '🏆 *LEADERBOARD*\n\n';
            sorted.forEach(([id, data], i) => {
                text += `${i + 1}. ${data.name || 'Unknown'}: $${data.balance + data.bank}\n`;
            });
            reply(text);
        }

        // CASINO COMMANDS
        else if (command === PREFIX + 'slots') {
            const bet = parseInt(args[1]) || 100;
            if (user.balance < bet) return reply('Insufficient balance!');
            const emojis = ['🍒', '🍋', '🍊', '🍇', '💎'];
            const slot1 = emojis[Math.floor(Math.random() * emojis.length)];
            const slot2 = emojis[Math.floor(Math.random() * emojis.length)];
            const slot3 = emojis[Math.floor(Math.random() * emojis.length)];
            
            if (slot1 === slot2 && slot2 === slot3) {
                const winAmount = bet * 5;
                user.balance += winAmount;
                reply(`🎰 ${slot1} | ${slot2} | ${slot3}\n\n🎉 JACKPOT! You won $${winAmount}!`);
            } else if (slot1 === slot2 || slot2 === slot3) {
                const winAmount = bet * 2;
                user.balance += winAmount;
                reply(`🎰 ${slot1} | ${slot2} | ${slot3}\n\n✅ You won $${winAmount}!`);
            } else {
                user.balance -= bet;
                reply(`🎰 ${slot1} | ${slot2} | ${slot3}\n\n❌ You lost $${bet}!`);
            }
        }

        else if (command === PREFIX + 'cf') {
            const bet = parseInt(args[1]);
            const choice = args[2]?.toLowerCase();
            if (!bet || !choice || !['heads', 'tails'].includes(choice)) {
                return reply('Usage: .cf <amount> <heads/tails>');
            }
            if (user.balance < bet) return reply('Insufficient balance!');
            const result = Math.random() > 0.5 ? 'heads' : 'tails';
            if (result === choice) {
                user.balance += bet;
                reply(`🪙 ${result.toUpperCase()}! You won $${bet}!`);
            } else {
                user.balance -= bet;
                reply(`🪙 ${result.toUpperCase()}! You lost $${bet}!`);
            }
        }

        // INTERACTION COMMANDS
        else if (['hug', 'kiss', 'slap', 'pat', 'punch', 'kill', 'wave', 'bonk'].includes(command.slice(1))) {
            const action = command.slice(1);
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!mentioned) return reply(`Usage: .${action} @user`);
            reply(`@${sender.split('@')[0]} ${action}ed @${mentioned.split('@')[0]}!`);
        }

        // SUPPORT COMMAND
        else if (command === PREFIX + 'support') {
            reply(`📞 *SUPPORT GROUP*\n\nJoin our official support group:\n\nhttps://chat.whatsapp.com/C58szhJGQ3EKlvFt1Hp57n\n\n✨ Get help, updates, and connect with other users!`);
        }

        // FUN COMMANDS
        else if (command === PREFIX + 'gay') {
            const percentage = Math.floor(Math.random() * 101);
            reply(`🏳️‍🌈 Gay meter: ${percentage}%`);
        }

        else if (command === PREFIX + 'ship') {
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if (!mentioned || mentioned.length < 2) return reply('Mention 2 users!');
            const percentage = Math.floor(Math.random() * 101);
            reply(`💕 Ship compatibility: ${percentage}%`);
        }

        else if (command === PREFIX + 'joke') {
            const jokes = [
                'Why don't scientists trust atoms? Because they make up everything!',
                'Why did the scarecrow win an award? He was outstanding in his field!',
                'Why don't eggs tell jokes? They'd crack up!'
            ];
            reply(jokes[Math.floor(Math.random() * jokes.length)]);
        }

        // ADMIN COMMANDS (Group only)
        else if (command === PREFIX + 'kick' && isGroup) {
            const groupMetadata = await sock.groupMetadata(from);
            const isAdmin = groupMetadata.participants.find(p => p.id === sender)?.admin;
            if (!isAdmin) return reply('Admin only!');
            
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!mentioned) return reply('Mention a user to kick!');
            
            await sock.groupParticipantsUpdate(from, [mentioned], 'remove');
            reply('✅ User kicked!');
        }

        else if (command === PREFIX + 'antilink' && isGroup) {
            const groupMetadata = await sock.groupMetadata(from);
            const isAdmin = groupMetadata.participants.find(p => p.id === sender)?.admin;
            if (!isAdmin) return reply('Admin only!');
            
            const group = initGroup(from);
            const action = args[1]?.toLowerCase();
            if (action === 'on') {
                group.antilink = true;
                reply('✅ Antilink enabled!');
            } else if (action === 'off') {
                group.antilink = false;
                reply('✅ Antilink disabled!');
            } else {
                reply(`Antilink is currently: ${group.antilink ? 'ON' : 'OFF'}`);
            }
        }

        // Check for links in group (antilink)
        if (isGroup) {
            const group = groups[from];
          
