import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "10mb" }));

  // Initialize Gemini AI client lazily
  let aiClient: GoogleGenAI | null = null;
  function getGeminiClient(): GoogleGenAI | null {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    if (!aiClient) {
      aiClient = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
    }
    return aiClient;
  }

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Helper function for server-side rule-based fallback advisory
  function generateServerFallbackAdvisory(items: any[], storeName: string) {
    const list = Array.isArray(items) ? items : [];
    const recommendations = list.map((p: any) => {
      const days = Number(p.daysLeft ?? p.days ?? 0);
      const name = p.name || p.productName || 'Produk';
      const qty = p.quantity || 1;
      const unit = p.unit || 'unit';
      const supplier = p.supplier || 'Supplier';

      if (days < 0) {
        return {
          productName: name,
          priority: 'Tinggi',
          action: 'Pemusnahan & Write-Off',
          reason: `Sudah kedaluwarsa (${Math.abs(days)} hari lalu). Segera tarik dari display rak dan buat Berita Acara Pemusnahan demi mematuhi regulasi BPOM.`,
        };
      } else if (days <= 3) {
        return {
          productName: name,
          priority: 'Tinggi',
          action: 'Retur Segera / Pisahkan Rak',
          reason: `Sisa ${days} hari (${qty} ${unit}). Segera pisahkan ke area retur atau jual dengan program bundling/diskon cuci gudang darurat.`,
        };
      } else if (days <= 7) {
        return {
          productName: name,
          priority: 'Tinggi',
          action: 'Retur ke Supplier',
          reason: `Sisa ${days} hari. Segera klaim retur ke distributor ${supplier} sebelum melewati batas waktu retur (H-3 s/d H-7).`,
        };
      } else {
        return {
          productName: name,
          priority: 'Sedang',
          action: 'Rotasi Display FEFO',
          reason: `Sisa ${days} hari (${qty} ${unit}). Terapkan rotasi First Expired First Out (pindahkan batch ini ke baris terdepan rak).`,
        };
      }
    });

    return {
      summary: `Analisis stok ${storeName || 'Toko'}: Terdeteksi ${list.length} produk memerlukan prioritas penanganan FEFO, retur supplier, dan pemusnahan barang rusak untuk mencegah kerugian finansial.`,
      totalRiskItems: list.length,
      recommendations: recommendations.slice(0, 8),
      preventionTips: [
        'Wajib jalankan rotasi display FEFO (First Expired, First Out) saat restock harian.',
        'Jadwalkan Stok Opname fisik berkala (mingguan/bulanan) untuk verifikasi selisih fisik vs sistem.',
        'Ajukan retur supplier minimal 7-14 hari sebelum tanggal kedaluwarsa sesuai perjanjian distributor.',
      ],
    };
  }

  // AI Stock & Expiry Advisory endpoint
  app.post("/api/gemini/analyze-stock", async (req, res) => {
    const { items, storeName } = req.body;
    const ai = getGeminiClient();

    if (!ai) {
      const fallbackData = generateServerFallbackAdvisory(items, storeName);
      return res.json({ success: true, data: fallbackData, isFallback: true });
    }

    const prompt = `Anda adalah asisten manajer operasional ritel & pencegahan kerugian stok toko (Loss Prevention Expert) di Indonesia untuk toko "${storeName || 'Toko Retail'}".
Berikut adalah daftar produk yang kedaluwarsa atau mendekati kedaluwarsa:
${JSON.stringify(items, null, 2)}

Buatkan analisis ringkas, taktis, dan rekomendasi aksi konkret dalam Bahasa Indonesia dengan format JSON valid berikut:
{
  "summary": "Ringkasan situasi risiko kedaluwarsa dalam 2 kalimat",
  "totalRiskItems": ${Array.isArray(items) ? items.length : 0},
  "recommendations": [
    {
      "productName": "Nama produk",
      "priority": "Tinggi",
      "action": "Diskon Cuci Gudang",
      "reason": "Alasan singkat dan taktik eksekusi (misal: buat promo Buy 1 Get 1 atau retur sebelum H-3)"
    }
  ],
  "preventionTips": [
    "Tip 1 untuk mencegah stok numpuk di masa depan (FEFO / penyesuaian min-order)",
    "Tip 2"
  ]
}`;

    // Candidate models to try in order when 503 (high demand) or rate limits occur
    const candidateModels = ["gemini-3.7-flash", "gemini-flash-latest", "gemini-3.1-flash-lite"];
    let lastError: any = null;

    for (const model of candidateModels) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            temperature: 0.2,
          },
        });

        const text = response.text || "{}";
        const parsed = JSON.parse(text);
        return res.json({ success: true, data: parsed, modelUsed: model });
      } catch (err: any) {
        lastError = err;
        console.warn(`Gemini model ${model} unavailable (${err?.status || err?.message || 'Error'}). Trying next candidate if available...`);
        // Small delay before trying next fallback model
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }

    console.error("All Gemini models encountered high demand or errors. Serving resilient heuristic analysis:", lastError?.message || lastError);
    const fallbackData = generateServerFallbackAdvisory(items, storeName);
    return res.json({
      success: true,
      data: fallbackData,
      isFallback: true,
      warning: "Model AI sedang dalam lonjakan trafik tinggi, menampilkan analisis sistem pakar otomatis."
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
