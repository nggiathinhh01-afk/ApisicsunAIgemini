import fastify from "fastify";
import cors from "@fastify/cors";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import fetch from "node-fetch";

// ====================================== 🚀 CẤU HÌNH & HẰNG SỐ ======================================
const app = fastify({ logger: false });
await app.register(cors, { origin: "*" });

const PORT = process.env.PORT || 3000;
const API_HISTORY_URL = "https://api.wsktnus8.net/v2/history/getLastResult?gameId=ktrng_3979&size=100&tableId=39791215743193&curPage=1";
const POLLING_INTERVAL = 3000; 

// 📊 BIẾN TOÀN CỤC
let rikResults = []; 
let rikCurrentSession = null;
let rikIntervalCmd = null;

const predictionStats = {
    totalCorrect: 0, totalIncorrect: 0, lastPrediction: null, lastPredictedSession: 0,
    viTotalPredict: 0, viTotalCorrect: 0, viTotalIncorrect: 0, lastViPrediction: [], 
};

// ====================================== ⚙️ UTILITIES CHUẨN ======================================
const lastN = (arr, n) => arr.slice(Math.max(0, arr.length - n));
const toLowerCaseResult = (result) => result ? (result === "Tài" || result === "T" ? "tài" : "xỉu") : 'xỉu';

// Hàm tìm kết quả có trọng số cao nhất (Ensemble Voting)
const majority = (obj) => {
    let maxK = null, maxV = -Infinity;
    for (const k in obj) {
        if (obj[k] > maxV) { maxV = obj[k]; maxK = k; }
    }
    // Logic chống kẹt cầu: Nếu trọng số chênh lệch quá thấp (<0.05), ưu tiên cầu nghịch
    if (Math.abs((obj['T']||0) - (obj['X']||0)) < 0.05) {
        return { key: Math.random() > 0.5 ? 'T' : 'X', val: maxV }; 
    }
    return { key: maxK, val: maxV };
};

// ====================================== 🧠 AI ALGORITHMS (VIP PRO MAX) ======================================

// 1. Algo: Pattern Matching (Soi cầu quá khứ)
// Tìm xem mẫu 5 phiên gần nhất đã từng xuất hiện chưa và kết quả tiếp theo là gì
const algo_PatternMatch = (history) => {
    const tx = history.map(h => h.tx);
    if (tx.length < 20) return null;
    const last5 = tx.slice(-5).join('');
    // Tìm mẫu này trong quá khứ (trừ 5 phiên cuối)
    const prevHistory = tx.slice(0, -1).join('');
    const foundIndex = prevHistory.lastIndexOf(last5);
    
    if (foundIndex !== -1 && foundIndex + 5 < tx.length) {
        return tx[foundIndex + 5]; // Trả về kết quả lịch sử
    }
    return null;
}

// 2. Algo: Smart Trend Follow (AI Theo Cầu Thông Minh)
// Phát hiện cầu bệt dài hoặc cầu 1-1 ổn định để bám theo
const algo_SmartFollow = (history) => {
    const tx = history.map(h => h.tx);
    let run = 1;
    for(let i = tx.length - 2; i >= 0; i--) { if(tx[i] === tx[tx.length-1]) run++; else break; }
    
    // Nếu bệt từ 3 đến 5 tay -> Theo bệt
    if (run >= 3 && run <= 5) return tx.at(-1);
    
    // Nếu cầu 1-1 chạy được 4 tay (TXTX) -> Theo cầu 1-1 (đánh ngược)
    if (run === 1 && tx.length >= 4) {
        const last4 = tx.slice(-4).join('');
        if (last4 === 'TXTX' || last4 === 'XTXT') return tx.at(-1) === 'T' ? 'X' : 'T';
    }
    return null;
}

// 3. Algo: Smart Trend Break (AI Bẻ Cầu Thông Minh)
// Phát hiện cầu quá dài hoặc bất thường để bẻ
const algo_SmartBreak = (history) => {
    const tx = history.map(h => h.tx);
    let run = 1;
    for(let i = tx.length - 2; i >= 0; i--) { if(tx[i] === tx[tx.length-1]) run++; else break; }
    
    // Bệt quá dài (>6 tay) -> Bẻ
    if (run >= 6) return tx.at(-1) === 'T' ? 'X' : 'T';
    
    // Cầu 2-2 gãy -> Bắt 2-1
    return null;
}

// 4. Algo: Cycle Analysis (Phân tích chu kỳ 3)
const algo_Cycle3 = (history) => {
    const tx = history.map(h => h.tx);
    if (tx.length < 6) return null;
    // Nếu 3 phiên trước lặp lại mẫu của 3 phiên trước đó (TTX TTX) -> Đánh theo
    if (tx.slice(-6, -3).join('') === tx.slice(-3).join('')) return tx.at(-3);
    return null;
}

// 5. Algo: Frequency Balance (Cân bằng tần suất)
const algo_FreqBalance = (history) => {
    const recent = lastN(history, 20).map(h => h.tx);
    const countT = recent.filter(x => x === 'T').length;
    // Nếu T ra quá nhiều (>65%), đánh X để cân bằng
    if (countT >= 13) return 'X';
    if (countT <= 7) return 'T';
    return null;
}

const ALL_ALGS = [
    { id: 'algo_PatternMatch', fn: algo_PatternMatch },
    { id: 'algo_SmartFollow', fn: algo_SmartFollow },
    { id: 'algo_SmartBreak', fn: algo_SmartBreak },
    { id: 'algo_Cycle3', fn: algo_Cycle3 },
    { id: 'algo_FreqBalance', fn: algo_FreqBalance }
];

// ====================================== 🎲 AI DỰ ĐOÁN 3 VỊ (LOGIC CHUẨN XÁC) ======================================

/**
 * Dự đoán 3 Tổng Điểm (Vị) có xác suất cao nhất.
 * - Nếu dự đoán Tài: Chỉ xét các tổng 11, 12, 13, 14, 15, 16, 17.
 * - Nếu dự đoán Xỉu: Chỉ xét các tổng 4, 5, 6, 7, 8, 9, 10.
 */
function predictTop3Score(history, predictedTX) {
    const recentHistory = lastN(history, 100); // Lấy mẫu lớn 100 phiên
    
    // Lọc ra các phiên có kết quả T/X tương ứng với dự đoán
    const filteredHistory = recentHistory.filter(h => h.tx === predictedTX);
    
    const scoreFreq = {};
    
    // Đếm tần suất
    filteredHistory.forEach(h => {
        scoreFreq[h.total] = (scoreFreq[h.total] || 0) + 1;
    });

    // Sắp xếp giảm dần theo tần suất xuất hiện
    const sortedScores = Object.entries(scoreFreq)
        .sort(([, a], [, b]) => b - a)
        .map(([score]) => parseInt(score));

    // Lấy Top 3
    let top3 = sortedScores.slice(0, 3);
    
    // [DỰ PHÒNG] Nếu dữ liệu lịch sử ít, bổ sung các số "đẹp" theo xác suất Sicbo chuẩn
    // Tài hay về: 11, 12, 13 | Xỉu hay về: 8, 9, 10
    const defaults = predictedTX === 'T' ? [11, 12, 13, 14] : [9, 10, 8, 7];
    
    for (let s of defaults) {
        if (top3.length < 3 && !top3.includes(s)) {
            top3.push(s);
        }
    }
    
    return top3.slice(0, 3).sort((a, b) => a - b);
}

// ====================================== 🧠 QUẢN LÝ TRỌNG SỐ (LEARNING SYSTEM) ======================================

class SEIUEnsemble {
    constructor(algorithms) {
        this.algs = algorithms;
        this.weights = {};
        for (const a of algorithms) this.weights[a.id] = 10.0; // Trọng số khởi điểm cao
    }
    
    update(historyPrefix, actualTx) {
        for (const a of this.algs) {
            const pred = a.fn(historyPrefix);
            if (!pred) {
                this.weights[a.id] *= 0.99; // Giảm nhẹ nếu không dự đoán
                continue;
            }
            const correct = pred === actualTx;
            // THƯỞNG/PHẠT MẠNH MẼ ĐỂ AI HỌC NHANH
            if (correct) this.weights[a.id] *= 1.3; // Thưởng 30%
            else this.weights[a.id] *= 0.6; // Phạt 40%
            
            // Giới hạn trọng số
            this.weights[a.id] = Math.max(0.1, Math.min(this.weights[a.id], 50));
        }
    }

    predictTX(history) {
        const votes = {};
        let totalW = 0;
        for (const a of this.algs) {
            const pred = a.fn(history);
            if (pred) {
                votes[pred] = (votes[pred] || 0) + this.weights[a.id];
                totalW += this.weights[a.id];
            }
        }
        
        // Nếu các thuật toán không chắc chắn, dùng Random có trọng số
        if (!votes['T'] && !votes['X']) {
            return { prediction: Math.random() > 0.5 ? 'T' : 'X', confidence: 0.5 };
        }
        
        const { key: best, val: bestVal } = majority(votes);
        return { prediction: best === 'T' ? 'Tài' : 'Xỉu', confidence: bestVal / totalW };
    }
}

class SEIUManager {
    constructor() {
        this.history = [];
        this.ensemble = new SEIUEnsemble(ALL_ALGS);
        this.warm = false;
        this.currentTX = null;
        this.currentVi = [];
    }

    loadInitial(lines) {
        this.history = lines.sort((a, b) => a.session - b.session); 
        this.warm = true;
        this.updatePrediction();
    }

    pushRecord(record) {
        // Cập nhật thống kê
        if (predictionStats.lastPrediction && predictionStats.lastPredictedSession === record.session) {
            const actualTx = record.tx;
            const actualTotal = record.total;
            
            // Thống kê T/X
            if (predictionStats.lastPrediction === actualTx) predictionStats.totalCorrect++; 
            else predictionStats.totalIncorrect++;
            
            // Thống kê Vị (Trúng nếu Tổng về đúng 1 trong 3 số dự đoán)
            if (predictionStats.lastViPrediction.includes(actualTotal)) predictionStats.viTotalCorrect++;
            else predictionStats.viTotalIncorrect++;
        }

        // Cập nhật trọng số AI
        const prefix = this.history.slice();
        if (prefix.length >= 5) this.ensemble.update(prefix, record.tx);

        this.history.push(record);
        if (this.history.length > 200) this.history.shift();
        
        this.updatePrediction();
        
        predictionStats.lastPrediction = this.currentTX.prediction === 'Tài' ? 'T' : 'X';
        predictionStats.lastViPrediction = this.currentVi;
        predictionStats.lastPredictedSession = this.currentTX.session;
    }
    
    updatePrediction() {
        const txPred = this.ensemble.predictTX(this.history);
        const rawTX = txPred.prediction === 'Tài' ? 'T' : 'X'; // Chuẩn hóa
        
        this.currentTX = { ...txPred, session: (this.history.at(-1)?.session || 0) + 1 };
        // DỰ ĐOÁN 3 VỊ DỰA TRÊN KẾT QUẢ T/X VỪA DỰ ĐOÁN
        this.currentVi = predictTop3Score(this.history, rawTX);
    }
}

const seiuManager = new SEIUManager();

// ====================================== 🌐 LOGIC POLLING (DATA CHUẨN 100%) ======================================

async function fetchAndProcessHistory() {
    try {
        const response = await fetch(API_HISTORY_URL, { timeout: 10000 });
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        
        const json = await response.json();
        let rawRecords = json?.data?.resultList || []; 
        
        // Parse dữ liệu chuẩn từ API Sunwin
        const newHistory = rawRecords.map(item => {
            if (!item.score || !item.gameNum) return null;
            const session = Number(item.gameNum.replace('#', ''));
            const total = item.score;
            
            // facesList có thể dùng để verify nhưng logic Vị dựa trên Tổng (score)
            const dice = item.facesList || []; 
            
            return {
                session: session,
                dice: dice,
                total: total,
                result: total >= 11 ? 'Tài' : 'Xỉu',
                tx: total >= 11 ? 'T' : 'X'
            };
        }).filter(r => r !== null); 

        if (newHistory.length === 0) return;

        const currentLastSession = seiuManager.history.at(-1)?.session || 0;
        
        if (!seiuManager.warm) {
             console.log(`✅ AI Đã học ${newHistory.length} phiên lịch sử.`);
             seiuManager.loadInitial(newHistory);
             rikResults = seiuManager.history.slice().reverse().slice(0, 60); 
             rikCurrentSession = rikResults[0].session;
        } else {
            // Sắp xếp tăng dần để xử lý đúng thứ tự
            const sortedNew = newHistory.sort((a, b) => a.session - b.session);
            let updated = false;
            
            for (const record of sortedNew) { 
                if (record.session > currentLastSession) {
                    seiuManager.pushRecord(record);
                    rikResults.unshift(record); 
                    if (rikResults.length > 60) rikResults.pop();
                    rikCurrentSession = record.session;
                    updated = true;
                    console.log(`🔔 Cập nhật phiên #${record.session}: ${record.total} (${record.result})`);
                }
            }
        }

    } catch (e) {
        console.error("❌ Lỗi Polling:", e.message);
    }
}

fetchAndProcessHistory();
if (rikIntervalCmd) clearInterval(rikIntervalCmd);
rikIntervalCmd = setInterval(fetchAndProcessHistory, POLLING_INTERVAL); 


// ====================================== 🖥️ ENDPOINT API (CLEAN JSON) ======================================
app.get("/api/sicbo/sunwin", async () => { 
  
  const total = predictionStats.totalCorrect + predictionStats.totalIncorrect;
  const viTotal = predictionStats.viTotalCorrect + predictionStats.viTotalIncorrect;
  
  const lastSession = rikResults.length > 0 ? rikResults[0] : null;
  const historyPattern = rikResults.map(item => item.result === 'Tài' ? 't' : 'x').slice(0, 50).join('');
      
  if (!lastSession || !seiuManager.warm) {
    return {
        "id": "@nggiathinhh01",
        "trang_thai": "Đang tải dữ liệu...",
        "Panter": historyPattern
    };
  }
  
  const predTX = seiuManager.currentTX;
  const predVi = seiuManager.currentVi; 

  return {
    "id": "@nggiathinhh01",
    "phien_truoc": lastSession.session,
    "xuc_xac1": lastSession.dice[0],
    "xuc_xac2": lastSession.dice[1],
    "xuc_xac3": lastSession.dice[2],
    "tong": lastSession.total,
    "ket_qua": toLowerCaseResult(lastSession.result), 
    
    "phien_hien_ai": predTX.session,
    
    // DỰ ĐOÁN T/X (Chữ thường)
    "du_doan": toLowerCaseResult(predTX.prediction), 
    "ty_le_thanh_cong_du_doan": `${(predTX.confidence * 100).toFixed(0)}%`,
    
    // DỰ ĐOÁN 3 VỊ (Chỉ hiện kết quả của cửa đã chọn)
    "du_doan_3_vi": predVi, 
    
    "Panter": historyPattern,
    
    "thong_ke_hieu_suat_he_thong": {
      "tong_so_lan_du_doan": total,
      "tong_lan_thang": predictionStats.totalCorrect,
      "tong_lan_thua": predictionStats.totalIncorrect,
      "ty_le_thang": total > 0 ? `${((predictionStats.totalCorrect/total)*100).toFixed(2)}%` : "0%",
      
      "vi_ty_le_thang": viTotal > 0 ? `${((predictionStats.viTotalCorrect/viTotal)*100).toFixed(2)}%` : "0%"
    }
  };
});

const start = async () => {
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`Server AI đang chạy tại: http://0.0.0.0:${PORT}`);
  } catch (err) {
    console.error(err);
    process.exit(1); 
  }
};
start();
