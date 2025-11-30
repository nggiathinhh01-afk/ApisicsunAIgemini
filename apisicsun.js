import fastify from "fastify";
import cors from "@fastify/cors";
import fetch from "node-fetch";

// ====================================== ⚙️ CẤU HÌNH HỆ THỐNG & HẰNG SỐ ======================================
const app = fastify({ logger: false });
await app.register(cors, { origin: "*" });

const PORT = process.env.PORT || 3000;
const API_URL = "https://api.wsktnus8.net/v2/history/getLastResult?gameId=ktrng_3979&size=100&tableId=39791215743193&curPage=1";
const POLLING_INTERVAL = 3000;
const AI_NAME = "GiazThinhhz👾";

const MAX_ALGO_WEIGHT = 5.0; // Giới hạn trọng số để không ai độc quyền

// Biến trạng thái
let sessionHistory = [];
let lastProcessedSession = 0;
let predictionStats = { wins: 0, losses: 0, lastPred: null, lastScorePred: [], lastPredictedSession: 0 };
let rikResults = []; 

// 🎯 CACHE DỰ ĐOÁN CHO PHIÊN TIẾP THEO (ĐẢM BẢO KẾT QUẢ CỐ ĐỊNH)
let currentPrediction = { tx: 'T', confidence: 0, scores: [], session: 0 }; 

// ====================================== 🛠️ UTILITIES ======================================
const toLowerCaseResult = (result) => result ? (result === "Tài" || result === "T" ? "tài" : "xỉu") : 'xỉu';
const lastN = (arr, n) => arr.slice(Math.max(0, arr.length - n));

// ====================================== 🧠 ENSEMBLE ALGORITHMS (T/X) ======================================

// 1. Trend Master (Săn Bệt và Cầu Đẹp)
const algo_TrendMaster = (history) => {
    const tx = history.map(h => h.tx);
    if (tx.length < 5) return null;
    const last3 = tx.slice(-3).join('');
    if (last3 === 'TTT' || last3 === 'TXT' || tx.slice(-2).join('') === 'TT') return 'T';
    if (last3 === 'XXX' || last3 === 'XTX' || tx.slice(-2).join('') === 'XX') return 'X';
    return null;
}

// 2. Smart Break (Chỉ Bẻ Cầu Dài Thông Minh)
const algo_SmartBreak = (history) => {
    const tx = history.map(h => h.tx);
    let run = 1;
    for(let i = tx.length - 2; i >= 0; i--) { if(tx[i] === tx[tx.length-1]) run++; else break; }
    if (run >= 7) return tx.at(-1) === 'T' ? 'X' : 'T'; 
    return null;
}

// 3. Pattern 2-1-2 (Cầu Dây Chuyền)
const algo_Pattern212 = (history) => { 
    const tx = history.map(h => h.tx);
    if (tx.length < 5) return null;
    const last5 = tx.slice(-5).join('');
    if (last5 === 'TTXXT') return 'X';
    if (last5 === 'XXTTX') return 'T';
    return null;
}

// 4. Matrix Cycle (-3)
const algo_Matrix3 = (history) => { 
    if (history.length < 5) return null;
    return history.at(-3).tx; 
}

// 5. Volatility Reversion (Đánh ngược khi quá loạn)
const algo_ChaosBreaker = (history) => {
    const recent = lastN(history, 8).map(h => h.tx);
    let flips = 0;
    for (let i = 0; i < recent.length - 1; i++) if (recent[i] !== recent[i+1]) flips++;
    if (flips >= 6) return recent.at(-1) === 'T' ? 'X' : 'T'; 
    return null;
}

const ALL_ALGORITHMS = [
    { name: "TrendMaster", fn: algo_TrendMaster, weight: 1.0 },
    { name: "SmartBreak", fn: algo_SmartBreak, weight: 1.0 },
    { name: "Pattern212", fn: algo_Pattern212, weight: 1.0 },
    { name: "Matrix3", fn: algo_Matrix3, weight: 1.0 },
    { name: "ChaosBreaker", fn: algo_ChaosBreaker, weight: 1.0 }
];

// ====================================== 🎲 DỰ ĐOÁN 3 VỊ "TỨ PHÂN VỊ" (ĐÃ TỐI ƯU KHÔNG LỖI CỐ ĐỊNH) ======================================

function predictAdvancedScores(history, predictedTX) {
    const validScores = predictedTX === 'T' ? [11, 12, 13, 14, 15, 16, 17] : [4, 5, 6, 7, 8, 9, 10];
    const recent = history.slice(-100).filter(h => h.tx === predictedTX);
    
    const freq = {};
    const pairFreq = {}; 
    recent.forEach(h => {
        if (validScores.includes(h.total)) {
            freq[h.total] = (freq[h.total] || 0) + 1;
            const dice = h.dice.sort();
            if (dice[0] === dice[1] || dice[1] === dice[2]) {
                pairFreq[h.total] = (pairFreq[h.total] || 0) + 1;
            }
        }
    });

    const hotScores = Object.keys(freq).sort((a, b) => freq[b] - freq[a]).map(Number);
    const pairScores = Object.keys(pairFreq).sort((a, b) => pairFreq[b] - pairFreq[a]).map(Number);
    
    const finalPicks = [];

    // [VỊ 1] THE CORE: Con số ra nhiều nhất
    if (hotScores.length > 0) finalPicks.push(hotScores[0]);

    // [VỊ 2] THE HIGH-PAYOUT: Con số có tỉ lệ Cặp cao nhất (Hoặc số nổ lớn)
    const highPayoutCandidates = predictedTX === 'T' ? [14, 15, 16, 17] : [4, 5, 6, 7];
    
    let pairCandidate = pairScores.find(s => highPayoutCandidates.includes(s) && !finalPicks.includes(s));
    if (!pairCandidate) {
        pairCandidate = highPayoutCandidates.find(s => !finalPicks.includes(s));
    }
    
    if (pairCandidate) {
        finalPicks.push(pairCandidate);
    } else if (hotScores.length > 1 && !finalPicks.includes(hotScores[1])) {
        finalPicks.push(hotScores[1]);
    }

    // [VỊ 3] THE DIVERSIFIER: Số lót (Lấy ngẫu nhiên *Cố định*)
    const remaining = validScores.filter(s => !finalPicks.includes(s));
    
    // **LỖI ĐÃ XẢY RA Ở ĐÂY:** Vì dùng Math.random, nó đã thay đổi liên tục.
    // **KHẮC PHỤC:** Sử dụng hash/index ngẫu nhiên cho ổn định, nhưng vì đã CACHE bên ngoài, 
    // ta vẫn dùng Math.random() nhưng nó chỉ được gọi 1 lần khi cache.

    if (remaining.length > 0) {
        // Hàm này chỉ chạy 1 lần khi cache, nên Math.random() là an toàn.
        const randomPick = remaining[Math.floor(Math.random() * remaining.length)]; 
        finalPicks.push(randomPick);
    }

    while (finalPicks.length < 3) {
        const fallback = validScores.find(s => !finalPicks.includes(s));
        if (fallback) finalPicks.push(fallback);
        else break;
    }

    return finalPicks.slice(0, 3).sort((a, b) => a - b);
}

// ====================================== ⚖️ CÂN BẰNG TRỌNG SỐ VÀ ĐỘ TIN CẬY THẬT ======================================

function updateAlgorithmWeights(actualTx) {
    ALL_ALGORITHMS.forEach(algo => {
        const pred = algo.fn(sessionHistory);
        if (!pred) {
            algo.weight = Math.max(0.1, algo.weight * 0.98);
            return;
        }

        if (pred === actualTx) {
            algo.weight *= 1.3;
        } else {
            algo.weight *= 0.6;
        }
        
        algo.weight = Math.min(algo.weight, MAX_ALGO_WEIGHT);
        algo.weight = Math.max(0.1, algo.weight);
    });
}

function analyzePrediction() {
    let votes = { T: 0, X: 0 };
    let totalWeight = 0;

    ALL_ALGORITHMS.forEach(algo => {
        const pred = algo.fn(sessionHistory);
        if (pred) {
            votes[pred] += algo.weight;
            totalWeight += algo.weight;
        }
    });

    if (totalWeight === 0) {
        const lastTx = sessionHistory.at(-1)?.tx || (Math.random() > 0.5 ? 'T' : 'X');
        return { prediction: lastTx, confidence: 45 };
    }

    const prediction = votes.T > votes.X ? 'T' : 'X';
    const winningVote = votes.T > votes.X ? votes.T : votes.X;
    
    // TÍNH ĐỘ TIN CẬY THẬT (REALITY CHECK)
    let baseConf = winningVote / totalWeight; 

    // Phân tích Độ Ổn Định (Stability)
    const recentTx = lastN(sessionHistory, 15).map(h => h.tx);
    let flips = 0;
    for(let i=0; i<recentTx.length-1; i++) if(recentTx[i] !== recentTx[i+1]) flips++;
    
    const stabilityFactor = 1 - (flips / 15);
    let adjustedConf = baseConf + (stabilityFactor - 0.5) * 0.2; 
    
    let finalConfPercent = Math.round(adjustedConf * 100);
    
    // Giới hạn cứng: Max 92%, Min 40%
    finalConfPercent = Math.min(92, Math.max(40, finalConfPercent));

    return { prediction, confidence: finalConfPercent };
}

// ====================================== 🎯 HÀM CACHE DỰ ĐOÁN (FIX LỖI NHẢY VỊ) ======================================

function calculateNextPrediction() {
    if (sessionHistory.length === 0) return;

    // 1. Chạy các thuật toán T/X
    const aiResult = analyzePrediction();
    
    // 2. Chạy thuật toán 3 Vị (có random element)
    const predictedScores = predictAdvancedScores(sessionHistory, aiResult.prediction);

    // 3. CACHE KẾT QUẢ
    currentPrediction.tx = aiResult.prediction;
    currentPrediction.confidence = aiResult.confidence;
    currentPrediction.scores = predictedScores;
    currentPrediction.session = sessionHistory.at(-1).session + 1;
    
    // 4. Lưu lại cho thống kê vòng sau
    predictionStats.lastPred = aiResult.prediction;
    predictionStats.lastScorePred = predictedScores;
    predictionStats.lastPredictedSession = currentPrediction.session;
}


// ====================================== 📡 XỬ LÝ DỮ LIỆU & POLLING ======================================

async function updateData() {
    try {
        const res = await fetch(API_URL, { timeout: 10000 });
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        
        const json = await res.json();
        const raw = json?.data?.resultList || [];

        const newRecords = raw.map(r => ({
            session: parseInt(r.gameNum.replace('#','')),
            total: r.score,
            tx: r.score >= 11 ? 'T' : 'X',
            dice: r.facesList
        })).filter(r => r.dice && r.dice.length === 3)
           .sort((a,b) => a.session - b.session);

        if (newRecords.length === 0) return;

        const latest = newRecords[newRecords.length - 1];
        
        if (sessionHistory.length === 0 || latest.session > lastProcessedSession) {
            
            if (sessionHistory.length > 0) {
                const actualTx = latest.tx;
                const lastPred = predictionStats.lastPred;
                
                // Cập nhật thống kê
                if (lastPred && predictionStats.lastPredictedSession === latest.session) {
                    if (lastPred === actualTx) predictionStats.wins++;
                    else predictionStats.losses++;
                }

                // Cập nhật trọng số AI
                updateAlgorithmWeights(actualTx);
            }

            sessionHistory = newRecords;
            rikResults = sessionHistory.slice().reverse().slice(0, 60);
            lastProcessedSession = latest.session;
            
            // CHỈ GỌI HÀM DỰ ĐOÁN 1 LẦN KHI CÓ KẾT QUẢ MỚI
            calculateNextPrediction(); 
            
            console.log(`🔔 Cập nhật phiên #${latest.session}: ${latest.total} (${latest.tx}). AI Dự đoán phiên #${currentPrediction.session} là ${currentPrediction.tx} (${currentPrediction.confidence}%)`);
        }
    } catch (e) {
        console.error("Lỗi mạng:", e.message);
    }
}

// Loop update
setInterval(updateData, POLLING_INTERVAL);
updateData(); 

// ====================================== 🖥️ API ENDPOINT ======================================

app.get("/api/sicbo/sunwin", async (req, reply) => {
    if (sessionHistory.length === 0) return { status: "Đang tải dữ liệu..." };

    const lastGame = sessionHistory[sessionHistory.length - 1];
    
    // SỬ DỤNG KẾT QUẢ ĐÃ CACHE, KHÔNG CHẠY LẠI THUẬT TOÁN
    const predTX = currentPrediction;
    const predictedScores = currentPrediction.scores;

    const totalGames = predictionStats.wins + predictionStats.losses;
    const winRate = totalGames > 0 ? ((predictionStats.wins / totalGames) * 100).toFixed(2) : "0.00";
    
    const historyPattern = rikResults.map(item => item.tx === 'T' ? 't' : 'x').join('');

    return {
        id: AI_NAME,
        phien_truoc: lastGame.session,
        xuc_xac1: lastGame.dice[0], xuc_xac2: lastGame.dice[1], xuc_xac3: lastGame.dice[2],
        tong: lastGame.total,
        ket_qua: toLowerCaseResult(lastGame.tx), 
        
        phien_hien_ai: predTX.session,
        
        // DỰ ĐOÁN T/X: Độ tin cậy THẬT (Max 92%)
        du_doan: toLowerCaseResult(predTX.tx), 
        ty_le_thanh_cong_du_doan: `${predTX.confidence}%`, 
        
        // DỰ ĐOÁN 3 VỊ: Đa dạng (KHÔNG CỐ ĐỊNH VÀ KHÔNG NHẢY VỊ TRONG CÙNG PHIÊN)
        du_doan_3_vi: predictedScores, 
        
        Panter: historyPattern,
        
        thong_ke_hieu_suat_he_thong: {
            tong_so_lan_du_doan: totalGames,
            tong_lan_thang: predictionStats.wins,
            tong_lan_thua: predictionStats.losses,
            ty_le_thang: `${winRate}%`
        }
    };
});

const start = async () => {
    try {
        await app.listen({ port: PORT, host: "0.0.0.0" });
        console.log(`Server AI running at: http://localhost:${PORT}`);
    } catch (err) {
        process.exit(1);
    }
};
start();
