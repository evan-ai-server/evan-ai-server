// index.js (ESM)
// Evan AI server — optimized, cache-safe, structured-output Vision

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import fetch from "node-fetch";
import multer from "multer";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import pLimit from "p-limit";
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import helmet from "helmet";
import { imageSimilarityScore } from "./intelligence/imageSimilarity.js";
import { recordPriceObservation, getHistoricalStats } from "./intelligence/priceHistory.js";
import { rememberProduct, getProductMemory } from "./intelligence/productMemory.js";
import { categoryAdapter } from "./intelligence/categoryAdapters.js";
import { recordWatch, watchlistTrend } from "./intelligence/watchlistEngine.js";

import { fuseIdentity } from "./intelligence/phase1/identityFusion.js";
import { imageEmbeddingScore } from "./intelligence/phase1/imageEmbeddings.js";
import { rememberProductNode, getProductNeighbors } from "./intelligence/phase1/productGraph.js";
import { reverseImageCandidates } from "./intelligence/phase1/reverseSearch.js";
import { listingTrustScore } from "./intelligence/phase1/trustModel.js";
import { extractVisualFeatures } from "./intelligence/phase1/visualFeatures.js";
import { evolveQueries } from "./intelligence/phase1/queryEvolution.js";
import { rememberQuerySuccess, bestHistoricalQuery } from "./intelligence/phase1/retrievalMemory.js";

import { priceDistribution } from "./intelligence/phase2/priceModel.js";
import { flipOpportunity } from "./intelligence/phase2/flipDetection.js";
import { scanConfidence } from "./intelligence/phase2/confidenceEngine.js";
import { preferenceBoost } from "./intelligence/phase2/personalization.js";
import { categorySignals } from "./intelligence/phase2/categoryModels.js";
import { rememberListings } from "./intelligence/phase2/backgroundCrawler.js";
import { clusterListings } from "./intelligence/phase2/resultClustering.js";

import { enrichProduct } from "./intelligence/phase3/backgroundEnrichment.js";
import { recordMarketActivity, marketHeat } from "./intelligence/phase3/marketTiming.js";
import { recordSeller } from "./intelligence/phase3/sellerIntelligence.js";
import { flipScore } from "./intelligence/phase3/flipModel.js";
import { canonicalizeQuery } from "./intelligence/phase3/canonicalizer.js";
import { recordUserInterest, userPreferenceBoost } from "./intelligence/phase3/userLearning.js";

import { rememberProduct as rememberFinalProduct, productStats } from "./intelligence/final/productMemory.js";
import { sellerScore as finalSellerScore } from "./intelligence/final/sellerIntel.js";
import { detectDeal } from "./intelligence/final/dealHunter.js";
import { storeVector } from "./intelligence/vision/embeddingSearch.js";

import { counterfeitRiskScore, authSummary } from "./intelligence/final/authEngine.js";
import { buildDealHunterPayload } from "./intelligence/final/dealHunterAgent.js";
import { buildSellSideEstimate } from "./intelligence/final/sellSideAgent.js";

import { visualProductSearch } from "./intelligence/billion/visualSearch.js";
import { arbitrageScore } from "./intelligence/billion/arbitrageEngine.js";
import { predictPrice } from "./intelligence/billion/pricePredictor.js";
import { authenticityScore } from "./intelligence/billion/fakeDetector.js";
import { marketTrend, recordScan } from "./intelligence/billion/marketPulse.js";
import { addVisualWatch } from "./intelligence/billion/visualWatchlist.js";
import { updateProductGraph } from "./intelligence/billion/productGraphAI.js";
import { sellRecommendation } from "./intelligence/billion/sellAdvisor.js";
import { overlayInsight } from "./intelligence/billion/cameraMarketOverlay.js";

import { computeSoldCompStats } from "./intelligence/moat/soldCompEngine.js";
import { estimateSellThrough } from "./intelligence/moat/sellThroughEngine.js";
import { predictExitPrice } from "./intelligence/moat/exitPriceModel.js";
import { rankVisualComps } from "./intelligence/moat/visualCompRanker.js";
import { classifyAesthetic } from "./intelligence/moat/aestheticClassifier.js";
import { trustScore as moatTrustScore } from "./intelligence/moat/trustMap.js";
import { demandRadar } from "./intelligence/moat/demandRadar.js";

import { createLeaderElection } from "./infra/leaderElection.js";
import { createDistributedSingleflight } from "./infra/distributedSingleflight.js";
import { createSourceBudgetManager } from "./profit/sourceBudget.js";
import { createDurableIdempotencyMiddleware } from "./infra/durableIdempotency.js";

import {
  computeImageEmbedding,
  cosineSimilarity,
  nearestVectors
} from "./intelligence/vision/embeddingSearch.js";

import {
  initializeRetrievalCore,
  getRetrievalStats,
  upsertQuerySnapshot,
  getQuerySnapshot,
  searchRetrievalIndex,
  upsertCanonicalProduct,
  upsertScanVector,
  searchNearestStoredVectors,
} from "./retrievalCore.js";

import {
  initializeIntelligenceLayer,
  getIntelligenceStats,
  recordPriceHistory,
  getPriceHistorySummary,
  recordSoldCompHistory,
  getSoldCompSummary,
  rerankWithIntelligence,
  recordWatchHeartbeat,
  buildWatchSignals,
  recordCrawlerRefresh,
  getCrawlerQueueCandidates,
} from "./intelligenceLayer.js";

import {
  initializeProductScale,
  getProductScaleStats,
  getUserProfile,
  upsertUserProfile,
  enqueueNotification,
  listNotifications,
  markNotificationsRead,
  recordAnalyticsEventScaled,
  getAnalyticsSummary,
  savePrecomputeSnapshot,
  getPrecomputeSnapshot,
  maybeHydrateUserFromActivity,
} from "./productScale.js";

import {
  initializeHardeningLayer,
  getHardeningStats,
  getHardeningDebugSnapshot,
  buildHardeningMiddleware,
  recordRouteObservation,
  recordHardeningEvent,
  withModelServing,
  createBackupSnapshot,
  listBackupSnapshots,
  startBackupLoop,
} from "./hardeningLayer.js";

import {
  initializeGlobalScaleLayer,
  getGlobalScaleStats,
  getGlobalScaleDebugSnapshot,
  getGlobalHealthSnapshot,
  buildGlobalScaleMiddleware,
  recordGlobalRequestObservation,
  setActiveRegion,
  replicateGlobalState,
  listReplicationSnapshots,
  startGlobalReplicationLoop,
  startGlobalResilienceLoop,
  } from "./globalScaleLayer.js";

  import {
    fingerprintItem,
    ingestScanToGraph,
    recordSoldOutcome,
    queryResaleGraph,
    getPlatformPerformance,
    getKnownAuthSignals,
    getTopSoldMonthComps,
  } from "./src/resaleGraph.js";

  import {
    parseSerialFromImage,
    parseSerialFromText,
  } from "./src/serialParser.js";

  import {
    normalizeAttributeCertaintyMap,
    mergeAttributeCertaintyMaps,
    buildAttributeCertaintyPayload,
    inferAttributeCertaintyFromIdentity,
  } from "./src/attributeCertaintyMap.js";

  import {
    runCounterfactualScan,
  } from "./src/counterfactualEngine.js";
                                                                                                                                                                                                        
  import {
    gradeCondition,                                                                                                                                                                                     
  } from "./src/conditionGrader.js";                                                                                                                                                                  

  import {
    computeLiquidityScore,
  } from "./src/liquidityEngine.js";                                                                                                                                                                    
  
  import {                                                                                                                                                                                              
    buildExitStrategy,                                                                                                                                                                                
  } from "./src/exitStrategy.js";                                                                                                                                                                       
                                                                                                                                                                                                      
  import {
    recordScanReplay,
    markScanOutcome,                                                                                                                                                                                    
    getScanReplay,
    getUserScanReplays,                                                                                                                                                                                 
    analyzeFailurePatterns,                                                                                                                                                                           
  } from "./src/scanReplay.js";                                                                                                                                                                         
                                                                                                                                                                                                      
  import {                                                                                                                                                                                              
    addPortfolioItem,                                                                                                                                                                                 
    getPortfolioSummary,
    listPortfolioItems,                                                                                                                                                                                 
    getPortfolioItem,
    updatePortfolioItemValue,                                                                                                                                                                           
    markPortfolioItemSold,                                                                                                                                                                              
    removePortfolioItem,                                                                                                                                                                                
    getPortfolioPerformance,                                                                                                                                                                            
  } from "./src/portfolio.js";                                                                                                                                                                          
                                                                                                                                                                                                        
  import {
    generateItemRecommendation,
    runAutopilotForUser,
    storeAutopilotRecommendations,
    getAutopilotRecommendations,
  } from "./src/inventoryAutopilot.js";

  import {
    buildSubstituteIntelPayload,
    findSameItemCheaper,
    findVisualSubstitutes,
    detectCheaperPlatformListing,
  } from "./src/substituteIntel.js";

  import {
    findBudgetAlternative,
    scorePremiumVsValue,
    buildDontBuyThisPayload,
  } from "./src/cheaperAlternativeEngine.js";

  import {
    buildArbitrageIntelPayload,
    detectPlatformArbitrage,
    detectBuyOpportunity,
    detectMarketMomentum,
  } from "./src/hiddenArbitrageDetector.js";

  import {
    buildDealComparatorPayload,
    compareDealToMarket,
    buildDealVerdict,
    computePriceDropSignal,
  } from "./src/dealComparator.js";

  import {
    buildTrendIntelPayload,
    resolveHypeCycle,
  } from "./src/trendIntelEngine.js";

  import {
    buildAuthenticityIntelPayload,
    resolveBrandAuthProfile,
    detectPriceFloorViolation,
    computeLayeredAuthRisk,
  } from "./src/authenticityIntelligence.js";

  import {
    buildResaleOptimizerPayload,
    buildOptimalListingTitle,
    buildPriceLadder,
    recommendListingPlatform,
  } from "./src/resaleOptimizer.js";

  import {
    buildBundleIntelPayload,
    resolveBundleAccessories,
    computeBundlePremium,
  } from "./src/bundleIntelligence.js";

  import {
    buildPriceHistoryIntelPayload,
    getSeasonalPricePosition,
    getUpcomingSaleWindows,
    computeMarketPriceContext,
  } from "./src/priceHistoryIntelligence.js";

  import {
    buildConditionPricingPayload,
    normalizeConditionKey,
    computeConditionAdjustedPrice,
    detectConditionPriceMismatch,
    buildConditionNegotiationAnchors,
  } from "./src/conditionPricingAdjuster.js";

  import {
    buildDemandSignalPayload,
    scoreScarcity,
    computeSellThroughPressure,
    detectPriceCompression,
  } from "./src/demandSignalEngine.js";

  import {
    buildNegotiationIntelPayload,
    scoreSellerMotivation,
    computeOptimalOffer,
    buildNegotiationScript,
  } from "./src/negotiationIntelligence.js";

  import {
    buildRiskScorePayload,
    computePurchaseRiskScore,
  } from "./src/riskScoreEngine.js";

  import {
    buildSellerProfilePayload,
    computeSellerTrustScore,
    detectSellerRedFlags,
  } from "./src/sellerProfileIntelligence.js";

  import {
    buildCategorySpecificIntel,
    analyzeSneakerIntel,
    analyzeElectronicsIntel,
    analyzeWatchIntel,
    analyzeBagIntel,
  } from "./src/categorySpecificIntel.js";

  import {
    buildSmartAlertPayload,
    evaluateAlertTriggers,
    buildNotificationPayload,
  } from "./src/smartAlertEngine.js";

  import {
    buildProfitCalculatorPayload,
    computePlatformProfit,
    comparePlatformProfits,
    computeBreakEven,
    buildProfitScenarios,
  } from "./src/profitCalculatorEngine.js";

  import {
    buildImageContextPayload,
    classifyPhotoType,
    scoreLightingQuality,
    detectMultiItemFrame,
  } from "./src/imageContextEngine.js";

  import {
    addToWatchlist,
    removeFromWatchlist,
    listWatchlistItems,
    recordWatchlistPriceObservation,
    getWatchlistPriceHistory,
    checkWatchlistAlerts,
    getWatcherCount,
    buildWatchlistDemandSignal,
  } from "./src/watchlistIntelligence.js";

  import {
    buildEvanSummary,
    computeEvanScore,
  } from "./src/evanSummaryEngine.js";

  import {
    buildDNAMatchPayload,
    computeDNAMatchScore,
    rankDNASubstitutes,
  } from "./src/dnaMatchEngine.js";

  import {
    buildPriceAnomalyPayload,
    analyzeScannedPriceAnomaly,
    flagMarketAnomalies,
  } from "./src/priceAnomalyDetector.js";

  import {
    buildValueDepreciationCurve,
  } from "./src/valueDepreciationCurve.js";

  import {
    buildQueryArbitragePayload,
    generatePlatformQueries,
    detectMislabelingArbitrage,
    detectNamingGapArbitrage,
  } from "./src/queryArbitrageEngine.js";
import { buildSizeArbitragePayload, scoreSizeDemand, detectSizeArbitrage } from "./src/sizeArbitrageEngine.js";
import { buildColorwaySubstitutePayload, extractColorPalette, colorPaletteSimilarity, findColorwaySubstitutes } from "./src/colorwaySubstituteEngine.js";
import { buildReleaseCalendarPayload, lookupMSRP, computeResalePremium, buildRestockIntelligence } from "./src/releaseCalendarIntelligence.js";
import { buildConditionForensicsPayload, detectDamageSignatures, computeTotalDamageImpact, buildBuyerDamageScript, buildSellerDisclosureScript } from "./src/itemConditionForensics.js";
import { buildAlternativeMarketplacePayload, getAlternativeMarkets, computeAlternativeMarketSavings, buildAlternativeSearchLinks } from "./src/alternativeMarketplaceRadar.js";
import { buildCrossListingDeduplicatorPayload, deduplicateListings, detectGhostListings, buildDeduplicatedMarket } from "./src/crossListingDeduplicator.js";
import { buildFakeListingDetectorPayload, scoreFakeListingRisk, scanMarketForFakes } from "./src/fakeListingDetector.js";
import { buildSeasonalFlipCalendarPayload, computeFlipTiming, getBuySellWindows, getUpcomingDemandEvents } from "./src/seasonalFlipCalendar.js";
import { buildBrandTierPayload, resolveBrandTier, detectBrandPriceMismatch, findTierAlternatives } from "./src/brandTierClassifier.js";
import { buildSmartPriceTargetPayload, buildPriceTargets, computeMaxBuyPrice, computeOptimalSellPrice } from "./src/smartPriceTargetEngine.js";
import { buildListingQualityScorerPayload, scoreListingQuality } from "./src/listingQualityScorer.js";
import { buildMarketMomentumPayload, computePriceMomentum, detectPriceConvergence, computeSellThroughVelocity } from "./src/marketMomentumTracker.js";
import { buildFlipScorePayload, computeFlipScore } from "./src/flipScoreEngine.js";
import { buildScanToListPayload, generatePlatformListing } from "./src/scanToListPipeline.js";
import { buildDealLedgerPayload, logScanToLedger, getLedgerSummary, getRecentScans, getLeaderboard } from "./src/dealLedger.js";
import { buildComparativeBuyDecisionPayload, compareItems } from "./src/comparativeBuyDecision.js";
import { buildResaleSpeedPayload, predictDaysToSell, predictAllPlatforms } from "./src/resaleSpeedPredictor.js";
import { buildMarketDepthPayload, detectPriceWalls, computeBidAskSpread, scoreSupplyDemandImbalance } from "./src/marketDepthAnalyzer.js";
import { buildEvanIntelPulsePayload, evaluateScanForPulse, buildDailyPulse, setPulseConfig, getPulseConfig, pushPulseEvent } from "./src/evanIntelPulse.js";
import { buildSmartSubstituteRankerPayload, rankSubstitutes } from "./src/smartSubstituteRanker.js";
import { buildPricePredictionPayload, buildPriceProjection, projectPrice } from "./src/pricePredictionModel.js";
import { buildPortfolioPayload, addPortfolioItem as addTrackerPortfolioItem, removePortfolioItem as removeTrackerPortfolioItem, getPortfolio, updatePortfolioItemPrice } from "./src/portfolioTracker.js";
import { buildAuthServiceRouterPayload, findAuthServices, buildAuthRoute, computeAuthROI } from "./src/authServiceRouter.js";
import { buildCounteroferScriptPayload, buildCounteroffer } from "./src/counterofferScriptBuilder.js";
import { startThriftSession, addSessionScan, getSessionSummary, endThriftSession, getUserSessions } from "./src/thriftScannerMode.js";
import { buildEvanScoreExplainerPayload, extractSignals, buildExplanation } from "./src/evanScoreExplainer.js";
import { buildBuyOrPassPayload, computeBuyOrPass } from "./src/buyOrPassEngine.js";
import { buildBarcodeIntelligencePayload, extractBarcodesFromText, lookupBarcode } from "./src/barcodeIntelligence.js";
import { buildMultiAngleConsensusPayload, buildMultiAngleConsensus, detectPassConflicts } from "./src/multiAngleConsensus.js";
import { buildBoxTagPayload, extractBoxTagData, buildBoxTagEnhancedQuery } from "./src/boxTagExtractor.js";
import { buildSellerJargonPayload, normalizeSellerJargon, buildNormalizedQuery } from "./src/sellerJargonNormalizer.js";
import { buildLogoConfidencePayload, scoreSingleBrand, scoreAllBrands } from "./src/logoConfidenceScorer.js";
import { buildSealTagPayload, detectSealsAndTags, applyConditionUpgrade, computeTagAdjustedPrice } from "./src/sealTagDetector.js";
import { buildCounterfeitDiffPayload, autoRunVisualDiff, runVisualDiff } from "./src/counterfeitVisualDiff.js";
import { buildSoldCompsDateFilterPayload, buildSoldCompsAnalysis, filterSoldCompsByDate } from "./src/soldCompsDateFilter.js";
import { buildPremiumPriceSourcesPayload, fetchPremiumPrices } from "./src/premiumPriceSources.js";
import { buildPriceFloorPayload, getPriceFloor, recordSoldPrices, ingestMarketItemsIntoFloor } from "./src/priceFloorTracker.js";
import { buildPriceAlertPayload, firePriceAlert, registerWebhook, unregisterWebhook, getWebhookConfig, shouldFireAlert } from "./src/priceAlertWebhooks.js";
import { buildConditionTierPayload, priceByConditionTier, classifyCondition, estimatePriceForCondition } from "./src/conditionTierPricer.js";
import { buildRegionalPricePayload, fetchRegionalPrices } from "./src/regionalPriceVariance.js";
import { buildLotBundlePayload, analyzeBatchForLots, detectLotBundle, computePerUnitPrice } from "./src/lotBundleDetector.js";

  dotenv.config();


const app = express();
app.disable("x-powered-by");
const TRUST_PROXY_RAW = String(process.env.TRUST_PROXY || "1").toLowerCase();

app.set(
  "trust proxy",
  TRUST_PROXY_RAW === "true"
    ? true
    : Number.isFinite(Number(TRUST_PROXY_RAW))
    ? Number(TRUST_PROXY_RAW)
    : 1
);
app.set("etag", false);

// -------------------- ENV --------------------
const visionConcurrency = pLimit(
  Math.max(2, Number(process.env.VISION_CONCURRENCY || 6))
);
const marketSearchConcurrency = pLimit(
  Math.max(2, Number(process.env.MARKET_SEARCH_CONCURRENCY || 3))
);

const ebayRenderConcurrency = pLimit(
  Math.max(1, Number(process.env.EBAY_RENDER_CONCURRENCY || 1))
);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const HOST = process.env.HOST || "0.0.0.0";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// keep this only for legacy routes you still have in the file
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";

// Etsy
const ETSY_API_KEY = process.env.ETSY_API_KEY || "";
const ETSY_SHARED_SECRET = process.env.ETSY_SHARED_SECRET || "";
const ETSY_OAUTH_TOKEN = process.env.ETSY_OAUTH_TOKEN || "";

// eBay
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID || "";
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || "";

// Walmart Marketplace
const WALMART_CLIENT_ID = process.env.WALMART_CLIENT_ID || "";
const WALMART_CLIENT_SECRET = process.env.WALMART_CLIENT_SECRET || "";
const WALMART_CHANNEL_TYPE = process.env.WALMART_CHANNEL_TYPE || "";
const WALMART_PARTNER_ID = process.env.WALMART_PARTNER_ID || "";
const WALMART_TENANT_ID = process.env.WALMART_TENANT_ID || "0";

// Best Buy
const BESTBUY_API_KEY = process.env.BESTBUY_API_KEY || "";

let ETSY_COOLDOWN_UNTIL = 0;

const VISION_MODEL =
  process.env.VISION_MODEL || "gpt-4.1";
const ENRICH_MODEL = process.env.ENRICH_MODEL || "gpt-4.1";
const TEXT_TIMEOUT_MS = process.env.TEXT_TIMEOUT_MS
  ? Number(process.env.TEXT_TIMEOUT_MS)
  : 8000;

const VISION_TIMEOUT_MS = process.env.VISION_TIMEOUT_MS
  ? Number(process.env.VISION_TIMEOUT_MS)
  : 12500;

// CORS: allow all by default; lock down in prod with ALLOWED_ORIGINS
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const IS_PROD =
  String(process.env.NODE_ENV || "").toLowerCase() === "production";

const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "2mb";
const URLENCODED_BODY_LIMIT = process.env.URLENCODED_BODY_LIMIT || "1mb";

const GLOBAL_RATE_WINDOW_MS = Number(process.env.GLOBAL_RATE_WINDOW_MS || 60_000);
const GLOBAL_RATE_MAX = Number(process.env.GLOBAL_RATE_MAX || 240);

const WRITE_RATE_WINDOW_MS = Number(process.env.WRITE_RATE_WINDOW_MS || 60_000);
const WRITE_RATE_MAX = Number(process.env.WRITE_RATE_MAX || 90);

const EDGE_SHARED_SECRET = String(process.env.EDGE_SHARED_SECRET || "");
const REQUIRE_EDGE_SECRET =
  String(process.env.REQUIRE_EDGE_SECRET || "").toLowerCase() === "true";

const OPS_SECRET = String(process.env.OPS_SECRET || "");

const API_VERSION = String(process.env.API_VERSION || "v1").trim();
const DEPLOY_REGION = String(
  process.env.DEPLOY_REGION || process.env.AWS_REGION || "us-east-1"
).trim();
const PRIMARY_REGION = String(process.env.PRIMARY_REGION || DEPLOY_REGION).trim();
const DEPLOYMENT_COLOR = String(process.env.DEPLOYMENT_COLOR || "blue").trim();

const PHASE5_ALERTS_ENABLED =
  String(process.env.PHASE5_ALERTS_ENABLED || "true").toLowerCase() === "true";

const PHASE5_ALERT_COOLDOWN_MS = Number(
  process.env.PHASE5_ALERT_COOLDOWN_MS || 5 * 60 * 1000
);

const PHASE5_ALERT_HISTORY_MAX = Math.max(
  50,
  Number(process.env.PHASE5_ALERT_HISTORY_MAX || 250)
);

const PHASE5_METRIC_HISTORY_MAX = Math.max(
  100,
  Number(process.env.PHASE5_METRIC_HISTORY_MAX || 1000)
);

const PHASE5_ABUSE_WINDOW_MS = Number(
  process.env.PHASE5_ABUSE_WINDOW_MS || 60 * 1000
);

const PHASE5_WRITE_IP_MAX = Number(process.env.PHASE5_WRITE_IP_MAX || 240);
const PHASE5_WRITE_DEVICE_MAX = Number(process.env.PHASE5_WRITE_DEVICE_MAX || 180);
const PHASE5_WRITE_USER_MAX = Number(process.env.PHASE5_WRITE_USER_MAX || 300);

const PHASE5_SCAN_IP_MAX = Number(process.env.PHASE5_SCAN_IP_MAX || 90);
const PHASE5_SCAN_DEVICE_MAX = Number(process.env.PHASE5_SCAN_DEVICE_MAX || 70);
const PHASE5_SCAN_USER_MAX = Number(process.env.PHASE5_SCAN_USER_MAX || 140);
const PHASE5_SCAN_ANON_MAX = Number(process.env.PHASE5_SCAN_ANON_MAX || 25);

const PHASE5_UPLOAD_IP_MAX = Number(process.env.PHASE5_UPLOAD_IP_MAX || 45);
const PHASE5_UPLOAD_DEVICE_MAX = Number(process.env.PHASE5_UPLOAD_DEVICE_MAX || 35);

const IDEMPOTENCY_TTL_SEC = Math.max(
  60,
  Number(process.env.IDEMPOTENCY_TTL_SEC || 24 * 60 * 60)
);

const _STORAGE_ROOT_EARLY = path.resolve(process.env.STORAGE_ROOT || "./storage");

const PHASE5_RESTORE_DRILL_ROOT = path.join(
  _STORAGE_ROOT_EARLY,
  "ops",
  "restore-drills"
);

const PHASE5_OPS_ROOT = path.join(_STORAGE_ROOT_EARLY, "ops");

const INSTANCE_ID = String(
  process.env.INSTANCE_ID || `${HOST}:${PORT}:pid-${process.pid}`
).slice(0, 96);

const REDIS_REQUIRED_IN_PROD =
  String(process.env.REDIS_REQUIRED_IN_PROD || "true").toLowerCase() === "true";

const REDIS_STATE_REFRESH_MS = Number(
  process.env.REDIS_STATE_REFRESH_MS || 5000
);

const STATE_MIRROR_TTL_SEC = Number(
  process.env.STATE_MIRROR_TTL_SEC || 24 * 60 * 60
);

const DISTRIBUTED_LOCK_TTL_MS = Number(
  process.env.DISTRIBUTED_LOCK_TTL_MS || 15_000
);

const DISTRIBUTED_WAIT_MS = Number(
  process.env.DISTRIBUTED_WAIT_MS || 12_000
);

const DISTRIBUTED_POLL_MS = Number(
  process.env.DISTRIBUTED_POLL_MS || 125
);

const ALERT_COOLDOWN_MS = Number(
  process.env.ALERT_COOLDOWN_MS || 5 * 60 * 1000
);

const STRUCTURED_LOGS =
  String(process.env.STRUCTURED_LOGS || "true").toLowerCase() === "true";

const SLOW_REQUEST_MS = Number(
  process.env.SLOW_REQUEST_MS || 4000
);

const ABUSE_IP_WINDOW_MS = Number(
  process.env.ABUSE_IP_WINDOW_MS || 60_000
);
const ABUSE_IP_MAX = Number(
  process.env.ABUSE_IP_MAX || 240
);

const ABUSE_DEVICE_WINDOW_MS = Number(
  process.env.ABUSE_DEVICE_WINDOW_MS || 60_000
);
const ABUSE_DEVICE_MAX = Number(
  process.env.ABUSE_DEVICE_MAX || 180
);

const ABUSE_USER_WINDOW_MS = Number(
  process.env.ABUSE_USER_WINDOW_MS || 60_000
);
const ABUSE_USER_MAX = Number(
  process.env.ABUSE_USER_MAX || 300
);

const ANON_SCAN_WINDOW_MS = Number(
  process.env.ANON_SCAN_WINDOW_MS || 60_000
);
const ANON_SCAN_MAX = Number(
  process.env.ANON_SCAN_MAX || 20
);

const SCAN_BURST_WINDOW_MS = Number(
  process.env.SCAN_BURST_WINDOW_MS || 10_000
);
const SCAN_BURST_MAX = Number(
  process.env.SCAN_BURST_MAX || 8
);

const AUTH_ENABLED =
  String(process.env.AUTH_ENABLED || "true").toLowerCase() === "true";

const AUTH_JWT_SECRET = String(process.env.AUTH_JWT_SECRET || "");
const AUTH_TOKEN_ISSUER = String(process.env.AUTH_TOKEN_ISSUER || "");
const AUTH_TOKEN_AUDIENCE = String(process.env.AUTH_TOKEN_AUDIENCE || "");

const AUTH_ALLOW_DEV_BODY_FALLBACK =
  !IS_PROD &&
  String(process.env.AUTH_ALLOW_DEV_BODY_FALLBACK || "true").toLowerCase() === "true";

const PLAN_SCAN_LIMIT_ANON = Number(process.env.PLAN_SCAN_LIMIT_ANON || 15);
const PLAN_SCAN_LIMIT_FREE = Number(process.env.PLAN_SCAN_LIMIT_FREE || 75);
const PLAN_SCAN_LIMIT_PRO = Number(process.env.PLAN_SCAN_LIMIT_PRO || 500);

const OBJECT_STORE_PROVIDER = String(
  process.env.OBJECT_STORE_PROVIDER || (IS_PROD ? "s3" : "local")
).toLowerCase();

const OBJECT_STORE_BUCKET = String(process.env.OBJECT_STORE_BUCKET || "");
const OBJECT_STORE_REGION = String(process.env.OBJECT_STORE_REGION || "auto");
const OBJECT_STORE_ENDPOINT = String(process.env.OBJECT_STORE_ENDPOINT || "");
const OBJECT_STORE_PUBLIC_BASE_URL = String(
  process.env.OBJECT_STORE_PUBLIC_BASE_URL || ""
).replace(/\/+$/, "");

const OBJECT_STORE_ACCESS_KEY_ID = String(
  process.env.OBJECT_STORE_ACCESS_KEY_ID || ""
);
const OBJECT_STORE_SECRET_ACCESS_KEY = String(
  process.env.OBJECT_STORE_SECRET_ACCESS_KEY || ""
);

const OBJECT_STORE_FORCE_PATH_STYLE =
  String(process.env.OBJECT_STORE_FORCE_PATH_STYLE || "false").toLowerCase() ===
  "true";

const PRESIGNED_UPLOAD_TTL_SEC = Number(
  process.env.PRESIGNED_UPLOAD_TTL_SEC || 900
);

const DIRECT_UPLOAD_TTL_SEC = Number(
  process.env.DIRECT_UPLOAD_TTL_SEC || 900
);

const SERVER_ROLE = String(process.env.SERVER_ROLE || "all").toLowerCase();

const QUEUE_WORKERS_ENABLED =
  String(
    process.env.QUEUE_WORKERS_ENABLED ||
      (SERVER_ROLE === "api" ? "false" : "true")
  ).toLowerCase() === "true";

const SCHEDULERS_ENABLED =
  String(
    process.env.SCHEDULERS_ENABLED ||
      (SERVER_ROLE === "api" ? "false" : "true")
  ).toLowerCase() === "true";

const LEADER_ELECTION_KEY = String(
  process.env.LEADER_ELECTION_KEY || "evanai:leader:v1"
);

const LEADER_TTL_MS = Number(process.env.LEADER_TTL_MS || 15_000);
const LEADER_RENEW_MS = Number(process.env.LEADER_RENEW_MS || 5_000);

const SINGLEFLIGHT_WAIT_MS = Number(
  process.env.SINGLEFLIGHT_WAIT_MS || 12_000
);

const SINGLEFLIGHT_RESULT_TTL_SEC = Number(
  process.env.SINGLEFLIGHT_RESULT_TTL_SEC || 45
);

const MARKET_ROUTE_CACHE_TTL_SEC = Number(
  process.env.MARKET_ROUTE_CACHE_TTL_SEC || 120
);

const PREPROCESS_THUMB_EDGE = Number(
  process.env.PREPROCESS_THUMB_EDGE || 320
);

function safeTimingEqual(a = "", b = "") {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));

  if (!aBuf.length || !bBuf.length) return false;
  if (aBuf.length !== bBuf.length) return false;

  return crypto.timingSafeEqual(aBuf, bBuf);
}

function getClientIp(req) {
  const cfIp = String(req.headers["cf-connecting-ip"] || "").trim();
  if (cfIp) return cfIp;

  const xff = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  if (xff) return xff;

  return req.ip || req.socket?.remoteAddress || "unknown";
}

function getClientFingerprint(req) {
  const ua = String(req.headers["user-agent"] || "").slice(0, 180) || "ua";
  return `${getClientIp(req)}|${ua}`;
}

const OPS_ALERTS = [];
const OPS_ALERT_STATE = new Map();

const METRIC_COUNTERS = new Map();
const METRIC_GAUGES = new Map();
const METRIC_TIMERS = new Map();

function normalizeOpaqueId(value, max = 128) {
  const out = String(value || "").trim();
  return out ? out.slice(0, max) : null;
}

function getDeviceId(req) {
  return (
    normalizeOpaqueId(req.headers["x-device-id"], 128) ||
    normalizeOpaqueId(req.headers["x-install-id"], 128) ||
    normalizeOpaqueId(req.headers["x-client-id"], 128) ||
    normalizeOpaqueId(req.query?.deviceId, 128) ||
    null
  );
}

function getActorId(req) {
  return (
    normalizeOpaqueId(req.headers["x-user-id"], 128) ||
    normalizeOpaqueId(req.query?.userId, 128) ||
    null
  );
}

function jsonSafe(value, depth = 0) {
  if (depth > 2) return "[depth_limit]";
  if (value === undefined) return null;
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }
  if (Buffer.isBuffer(value)) {
    return `[buffer:${value.length}]`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((x) => jsonSafe(x, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    let count = 0;
    for (const [k, v] of Object.entries(value)) {
      if (count >= 40) break;
      if (typeof v === "function") continue;
      out[k] = jsonSafe(v, depth + 1);
      count += 1;
    }
    return out;
  }
  return String(value);
}

function metricField(tags = {}) {
  const clean = {};
  for (const key of Object.keys(tags || {}).sort()) {
    const value = tags[key];
    if (value == null || value === "") continue;
    clean[key] = String(value);
  }
  return JSON.stringify(clean);
}

function incMetric(name, by = 1, tags = {}) {
  const field = metricField(tags);
  const key = `${name}|${field}`;
  METRIC_COUNTERS.set(key, Number(METRIC_COUNTERS.get(key) || 0) + Number(by || 0));

  if (redis) {
    redis
      .hincrby(`metrics:counter:${name}`, field, Number(by || 0))
      .catch(() => {});
  }
}

function setMetric(name, value, tags = {}) {
  const field = metricField(tags);
  const key = `${name}|${field}`;
  METRIC_GAUGES.set(key, Number(value || 0));

  if (redis) {
    redis
      .hset(`metrics:gauge:${name}`, field, String(Number(value || 0)))
      .catch(() => {});
  }
}

function observeMetric(name, value, tags = {}) {
  const n = Number(value || 0);
  const field = metricField(tags);
  const key = `${name}|${field}`;

  const current = METRIC_TIMERS.get(key) || {
    count: 0,
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: 0,
  };

  current.count += 1;
  current.sum += n;
  current.min = Math.min(current.min, n);
  current.max = Math.max(current.max, n);

  METRIC_TIMERS.set(key, current);

  if (redis) {
    redis
      .hset(
        `metrics:timer:${name}`,
        field,
        JSON.stringify({
          count: current.count,
          sum: current.sum,
          min: current.min,
          max: current.max,
        })
      )
      .catch(() => {});
  }
}

function snapshotMetrics() {
  const counters = [...METRIC_COUNTERS.entries()].map(([key, value]) => {
    const [name, field] = key.split("|");
    return {
      name,
      tags: JSON.parse(field || "{}"),
      value,
    };
  });

  const gauges = [...METRIC_GAUGES.entries()].map(([key, value]) => {
    const [name, field] = key.split("|");
    return {
      name,
      tags: JSON.parse(field || "{}"),
      value,
    };
  });

  const timers = [...METRIC_TIMERS.entries()].map(([key, value]) => {
    const [name, field] = key.split("|");
    return {
      name,
      tags: JSON.parse(field || "{}"),
      count: value.count,
      avg: value.count ? Number((value.sum / value.count).toFixed(2)) : 0,
      min: Number.isFinite(value.min) ? value.min : 0,
      max: value.max,
    };
  });

  return { counters, gauges, timers };
}

function logEvent(level = "info", event = "app_event", payload = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    instanceId: INSTANCE_ID,
    ...jsonSafe(payload),
  };

  const line = JSON.stringify(entry);

  if (!STRUCTURED_LOGS) {
    if (level === "error") console.error(event, payload);
    else if (level === "warn") console.warn(event, payload);
    else console.log(event, payload);
    return entry;
  }

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  return entry;
}

function pushOpsAlert(code, payload = {}, cooldownMs = ALERT_COOLDOWN_MS) {
  const scope =
    String(
      payload?.source ||
        payload?.route ||
        payload?.name ||
        payload?.kind ||
        payload?.target ||
        "global"
    ).slice(0, 120);

  const dedupeKey = `${code}:${scope}`;
  const lastTs = Number(OPS_ALERT_STATE.get(dedupeKey) || 0);

  if (Date.now() - lastTs < cooldownMs) {
    return null;
  }

  OPS_ALERT_STATE.set(dedupeKey, Date.now());

  const alert = {
    ts: new Date().toISOString(),
    code,
    scope,
    instanceId: INSTANCE_ID,
    ...jsonSafe(payload),
  };

  OPS_ALERTS.unshift(alert);
  if (OPS_ALERTS.length > 200) OPS_ALERTS.length = 200;

  incMetric("ops_alert_total", 1, { code, scope });
  logEvent("warn", "ops_alert", alert);

  return alert;
}

function shouldSkipInfraGuard(req) {
  return req.path === "/health" || req.path === "/ready";
}

function requireEdgeSecret(req, res, next) {
  if (!REQUIRE_EDGE_SECRET) return next();
  if (shouldSkipInfraGuard(req)) return next();

  const inbound = String(req.headers["x-edge-secret"] || "");
  if (safeTimingEqual(inbound, EDGE_SHARED_SECRET)) {
    return next();
  }

  return res.status(403).json({
    ok: false,
    error: "edge_forbidden",
  });
}

function requireOpsAccess(req, res, next) {
  if (!IS_PROD || !OPS_SECRET) return next();

  const inbound = String(req.headers["x-ops-secret"] || "");
  if (safeTimingEqual(inbound, OPS_SECRET)) {
    return next();
  }

  return res.status(404).json({ ok: false });
}

const globalApiLimiter = rateLimit({
  windowMs: GLOBAL_RATE_WINDOW_MS,
  max: GLOBAL_RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => shouldSkipInfraGuard(req),
  keyGenerator: (req) => getClientFingerprint(req),
  handler: (_req, res) => {
    return res.status(429).json({
      ok: false,
      error: "rate_limited",
    });
  },
});

const writeApiLimiter = rateLimit({
  windowMs: WRITE_RATE_WINDOW_MS,
  max: WRITE_RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    shouldSkipInfraGuard(req) ||
    req.method === "GET" ||
    req.method === "HEAD" ||
    req.method === "OPTIONS",
  keyGenerator: (req) => getClientFingerprint(req),
  handler: (_req, res) => {
    return res.status(429).json({
      ok: false,
      error: "write_rate_limited",
    });
  },
});

const LOCAL_WINDOW_COUNTERS = new Map();

setInterval(() => {
  const now = Date.now();

  for (const [key, value] of LOCAL_WINDOW_COUNTERS.entries()) {
    if (Number(value?.expiresAt || 0) <= now) {
      LOCAL_WINDOW_COUNTERS.delete(key);
    }
  }

  for (const [key, value] of OPS_ALERT_STATE.entries()) {
    if (now - Number(value || 0) > 24 * 60 * 60 * 1000) {
      OPS_ALERT_STATE.delete(key);
    }
  }

  for (const [key, value] of L2_STATE_REFRESH.entries()) {
    if (!value?.inflight && now - Number(value?.at || 0) > 10 * 60 * 1000) {
      L2_STATE_REFRESH.delete(key);
    }
  }
}, 60 * 1000).unref?.();

function localWindowCounterKey(key) {
  return `local_window:${key}`;
}

function incrementLocalWindowCounter(key, windowMs) {
  const mapKey = localWindowCounterKey(key);
  const now = Date.now();
  const existing = LOCAL_WINDOW_COUNTERS.get(mapKey);

  if (!existing || existing.expiresAt <= now) {
    LOCAL_WINDOW_COUNTERS.set(mapKey, {
      count: 1,
      expiresAt: now + windowMs,
    });
    return 1;
  }

  existing.count += 1;
  LOCAL_WINDOW_COUNTERS.set(mapKey, existing);
  return existing.count;
}

async function incrementDistributedWindowCounter(key, windowMs) {
  if (!redis) {
    return incrementLocalWindowCounter(key, windowMs);
  }

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.pexpire(key, windowMs);
  }
  return count;
}

function routeNeedsPhase1AbuseGuard(req) {
  const p = String(req.path || "");
  return (
    p === "/vision/analyze" ||
    p === "/api/vision/analyze" ||
    p === "/upload/image" ||
    p === "/api/upload/image" ||
    p.startsWith("/market/") ||
    p.startsWith("/watch/")
  );
}

function isVisionWriteRoute(req) {
  const p = String(req.path || "");
  return (
    req.method === "POST" &&
    (p === "/vision/analyze" ||
      p === "/api/vision/analyze" ||
      p === "/upload/image" ||
      p === "/api/upload/image")
  );
}

async function phase1AbuseProtection(req, res, next) {
  try {
    if (shouldSkipInfraGuard(req)) return next();
    if (!routeNeedsPhase1AbuseGuard(req)) return next();

    const ip = getClientIp(req) || "unknown";
    const deviceId = getDeviceId(req);
    const actorId = getActorId(req);
    const visionWrite = isVisionWriteRoute(req);

    const checks = [
      {
        scope: "ip",
        id: ip,
        windowMs: ABUSE_IP_WINDOW_MS,
        limit: ABUSE_IP_MAX,
      },
      {
        scope: "device",
        id: deviceId,
        windowMs: ABUSE_DEVICE_WINDOW_MS,
        limit: ABUSE_DEVICE_MAX,
      },
    ];

    if (actorId) {
      checks.push({
        scope: "user",
        id: actorId,
        windowMs: ABUSE_USER_WINDOW_MS,
        limit: ABUSE_USER_MAX,
      });
    }

    if (!actorId && visionWrite) {
      checks.push({
        scope: "anon_scan",
        id: ip,
        windowMs: ANON_SCAN_WINDOW_MS,
        limit: ANON_SCAN_MAX,
      });
    }

    if (visionWrite) {
      checks.push({
        scope: "scan_burst",
        id: deviceId || ip,
        windowMs: SCAN_BURST_WINDOW_MS,
        limit: SCAN_BURST_MAX,
      });
    }

    for (const check of checks) {
      if (!check.id) continue;

      const counterKey = [
        "abuse",
        check.scope,
        req.method,
        req.path,
        String(check.id).slice(0, 180),
      ].join(":");

      const count = await incrementDistributedWindowCounter(
        counterKey,
        check.windowMs
      );

      if (count > check.limit) {
        incMetric("abuse_block_total", 1, {
          scope: check.scope,
          route: req.path,
        });

        pushOpsAlert(
          "abuse_limit_exceeded",
          {
            scope: check.scope,
            route: req.path,
            method: req.method,
            count,
            limit: check.limit,
            ip,
            actorId,
            deviceId,
          },
          60_000
        );

        return res.status(429).json({
          ok: false,
          error: "abuse_limited",
          scope: check.scope,
        });
      }
    }

    return next();
  } catch (err) {
    logEvent("warn", "abuse_guard_failed_open", {
      route: req.path,
      method: req.method,
      error: err?.message || String(err),
    });
    return next();
  }
}

function base64UrlToBuffer(value = "") {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = normalized + (pad ? "=".repeat(4 - pad) : "");
  return Buffer.from(padded, "base64");
}

function parseJsonSafe(raw = "") {
  try {
    return JSON.parse(String(raw || ""));
  } catch {
    return null;
  }
}

function parseBearerToken(req) {
  const auth = String(req.headers.authorization || "").trim();
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice(7).trim();
  return token || null;
}

function normalizePlan(plan = "") {
  const p = String(plan || "").toLowerCase().trim();
  if (p === "pro") return "pro";
  if (p === "internal" || p === "admin") return "internal";
  if (p === "free") return "free";
  return "free";
}

function normalizeRoles(raw) {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x || "").toLowerCase().trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((x) => String(x || "").toLowerCase().trim())
      .filter(Boolean);
  }
  return [];
}

function verifyHs256Jwt(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    throw new Error("invalid_token_format");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJsonSafe(base64UrlToBuffer(encodedHeader).toString("utf8"));
  const payload = parseJsonSafe(base64UrlToBuffer(encodedPayload).toString("utf8"));

  if (!header || !payload) {
    throw new Error("invalid_token_json");
  }

  if (String(header.alg || "") !== "HS256") {
    throw new Error("unsupported_jwt_alg");
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest();

  const actual = base64UrlToBuffer(encodedSignature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error("invalid_jwt_signature");
  }

  const nowSec = Math.floor(Date.now() / 1000);

  if (payload.nbf && Number(payload.nbf) > nowSec) {
    throw new Error("token_not_active");
  }

  if (payload.exp && Number(payload.exp) <= nowSec) {
    throw new Error("token_expired");
  }

  if (AUTH_TOKEN_ISSUER && String(payload.iss || "") !== AUTH_TOKEN_ISSUER) {
    throw new Error("invalid_token_issuer");
  }

  if (AUTH_TOKEN_AUDIENCE && String(payload.aud || "") !== AUTH_TOKEN_AUDIENCE) {
    throw new Error("invalid_token_audience");
  }

  return payload;
}

function buildAuthContextFromClaims(claims = {}) {
  const userId =
    normalizeOpaqueId(claims.sub, 128) ||
    normalizeOpaqueId(claims.userId, 128) ||
    normalizeOpaqueId(claims.uid, 128) ||
    normalizeOpaqueId(claims.id, 128) ||
    null;

  const roles = normalizeRoles(claims.roles || claims.role);
  const internal =
    roles.includes("internal") ||
    roles.includes("admin") ||
    String(claims.plan || "").toLowerCase() === "internal";

  const plan = internal
    ? "internal"
    : normalizePlan(claims.plan || claims.tier || claims.subscription || "free");

  return {
    userId,
    email: normalizeOpaqueId(claims.email, 180),
    plan,
    roles,
    claims,
  };
}

function hasValidApiKey(req) {
  const key = String(req.headers["x-api-key"] || "");
  return !process.env.API_KEY || key === process.env.API_KEY;
}

function resolveDevelopmentFallbackUserId(req) {
  if (!AUTH_ALLOW_DEV_BODY_FALLBACK || IS_PROD) return null;

  return (
    normalizeOpaqueId(req.body?.userId, 128) ||
    normalizeOpaqueId(req.query?.userId, 128) ||
    normalizeOpaqueId(req.headers["x-user-id"], 128) ||
    null
  );
}

function getResolvedUserId(req) {
  return req.auth?.userId || resolveDevelopmentFallbackUserId(req) || null;
}

function getResolvedPlan(req) {
  if (req.auth?.plan) return req.auth.plan;
  return hasValidApiKey(req) ? "internal" : "free";
}

function getScanPlanLimit(plan = "free") {
  if (plan === "internal") return Number.POSITIVE_INFINITY;
  if (plan === "pro") return PLAN_SCAN_LIMIT_PRO;
  if (plan === "free") return PLAN_SCAN_LIMIT_FREE;
  return PLAN_SCAN_LIMIT_ANON;
}

async function attachAuthContext(req, _res, next) {
  req.auth = null;
  req.authError = null;

  if (!AUTH_ENABLED) return next();

  const token = parseBearerToken(req);
  if (!token) return next();

  if (!AUTH_JWT_SECRET) {
    req.authError = "auth_secret_missing";
    return next();
  }

  try {
    const claims = verifyHs256Jwt(token, AUTH_JWT_SECRET);
    const auth = buildAuthContextFromClaims(claims);

    if (!auth?.userId) {
      req.authError = "auth_user_missing";
      return next();
    }

    req.auth = auth;
    incMetric("auth_success_total", 1, { plan: auth.plan });
    return next();
  } catch (err) {
    req.authError = err?.message || "invalid_auth_token";
    incMetric("auth_invalid_total", 1, {
      reason: req.authError,
    });
    return next();
  }
}

function bindTrustedIdentity(req, _res, next) {
  const trustedUserId = getResolvedUserId(req);

  if (trustedUserId) {
    req.userId = trustedUserId;

    if (req.body && typeof req.body === "object") {
      req.body.userId = trustedUserId;
      if (req.auth?.plan) req.body.plan = req.auth.plan;
    }

    if (req.query && typeof req.query === "object") {
      req.query.userId = trustedUserId;
    }
  }

  return next();
}

function routeRequiresSignedUser(pathname = "") {
  const p = String(pathname || "");
  return (
    p === "/auth/me" ||
    p.startsWith("/history/") ||
    p.startsWith("/saved-scans") ||
    p.startsWith("/watchlist") ||
    p.startsWith("/referral/") ||
    p.startsWith("/notifications") ||
    p.startsWith("/user/profile") ||
    p.startsWith("/watch/")
  );
}

function routeAllowsUserOrApiKey(pathname = "") {
  const p = String(pathname || "");
  return (
    p === "/analytics/event" ||
    p === "/deal/hunt" ||
    p === "/sell/estimate" ||
    p === "/upload/presign" ||
    p === "/upload/complete" ||
    p === "/upload/image" ||
    p === "/api/upload/image" ||
    p === "/vision/analyze" ||
    p === "/api/vision/analyze" ||
    p.startsWith("/market/")
  );
}

function isScanQuotaRoute(req) {
  return (
    req.method === "POST" &&
    (req.path === "/vision/analyze" || req.path === "/api/vision/analyze")
  );
}

async function enforceScanQuota(req, res, next) {
  try {
    const plan = getResolvedPlan(req);
    const limit = getScanPlanLimit(plan);

    if (!Number.isFinite(limit)) return next();

    const identityKey =
      getResolvedUserId(req) ||
      getDeviceId(req) ||
      getClientIp(req) ||
      "anonymous";

    const dayKey = new Date().toISOString().slice(0, 10);
    const quotaKey = `quota:scan:${plan}:${stableStateKeyPart(identityKey)}:${dayKey}`;

    const used = await incrementDistributedWindowCounter(
      quotaKey,
      24 * 60 * 60 * 1000
    );

    res.setHeader("x-user-plan", plan);
    res.setHeader("x-scan-limit", String(limit));
    res.setHeader("x-scan-used", String(Math.min(used, limit)));

    if (used > limit) {
      incMetric("plan_quota_block_total", 1, { plan, route: req.path });
      return res.status(429).json({
        ok: false,
        error: "scan_quota_exceeded",
        plan,
        limit,
      });
    }

    return next();
  } catch (err) {
    logEvent("warn", "scan_quota_guard_failed_open", {
      route: req.path,
      error: err?.message || String(err),
    });
    return next();
  }
}

async function phase2RouteProtection(req, res, next) {
  const path = String(req.path || "");
  const hasSignedUser = !!req.auth?.userId;
  const hasDevFallbackUser = !!resolveDevelopmentFallbackUserId(req);
  const hasProductAccess = hasSignedUser || hasDevFallbackUser || hasValidApiKey(req);

  if (routeRequiresSignedUser(path) && !(hasSignedUser || hasDevFallbackUser)) {
    return res.status(401).json({
      ok: false,
      error: "auth_required",
    });
  }

  if (routeAllowsUserOrApiKey(path) && !hasProductAccess) {
    return res.status(401).json({
      ok: false,
      error: "auth_required",
    });
  }

  if (isScanQuotaRoute(req)) {
    return enforceScanQuota(req, res, next);
  }

  return next();
}

function requireProductAccess(req, res, next) {
  if (req.auth?.userId || resolveDevelopmentFallbackUserId(req) || hasValidApiKey(req)) {
    return next();
  }

  return res.status(401).json({
    ok: false,
    error: "auth_required",
  });
}

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);

      if (!ALLOWED_ORIGINS.length) {
        if (IS_PROD) return cb(new Error("CORS blocked"), false);
        return cb(null, true);
      }

      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    credentials: true,
  })
);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  })
);

app.use((req, res, next) => {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.use(requireEdgeSecret);
app.use(globalApiLimiter);
app.use(writeApiLimiter);

app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: URLENCODED_BODY_LIMIT }));
app.use((req, res, next) => {
  const oldJson = res.json;

  res.json = function (data) {
    try {
      const size = Buffer.byteLength(JSON.stringify(data));
      if (size > 5_000_000) {
        console.warn("⚠️ Large response trimmed:", req.originalUrl);
      }
    } catch {}

    return oldJson.call(this, data);
  };

  next();
});

app.use(attachAuthContext);
app.use(bindTrustedIdentity);
app.use(phase2RouteProtection);
app.use(phase1AbuseProtection);
app.use(buildHardeningMiddleware());
app.use(buildGlobalScaleMiddleware());

// -------------------- Request logger + request id --------------------
app.use((req, res, next) => {
  const inboundRid = safeStr(req.headers["x-request-id"], 120) || null;
  const rid = inboundRid || crypto.randomBytes(8).toString("hex");
  const traceId =
    safeStr(req.headers["x-trace-id"], 160) ||
    safeStr(req.inboundTrace, 200) ||
    rid;

  req.rid = rid;
  req.traceId = traceId;

  res.setHeader("x-request-id", rid);
  res.setHeader("x-trace-id", traceId);

  const actor = getRequestActor(req);
  const routeKey = normalizeRouteForMetrics(req.path);
  const startNs = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs =
      Number(process.hrtime.bigint() - startNs) / 1_000_000;

    incrementMetric("http_requests_total", {
      route: routeKey,
      method: req.method,
      status: String(res.statusCode),
    });

    observeLatencyMetric("http_request_duration_ms", durationMs, {
      route: routeKey,
      method: req.method,
    });

    if (res.statusCode >= 500) {
      incrementMetric("http_5xx_total", {
        route: routeKey,
        method: req.method,
      });
    }

    logStructured(
      res.statusCode >= 500
        ? "error"
        : durationMs > 4000
        ? "warn"
        : "info",
      "http_request_complete",
      {
        rid,
        traceId,
        method: req.method,
        route: routeKey,
        originalUrl: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        ip: actor.ip,
        userId: actor.userId,
        deviceId: actor.deviceId,
        edgeRegion: req.edgeRegion,
      }
    );

    if (durationMs > 4000) {
      Promise.resolve()
        .then(() =>
          emitOpsAlert(
            "slow_request",
            {
              rid,
              route: req.originalUrl,
              method: req.method,
              statusCode: res.statusCode,
              durationMs: Math.round(durationMs * 100) / 100,
            },
            { severity: "warn", cooldownMs: 60_000 }
          )
        )
        .catch(() => {});
    }

    recordRouteObservation({
      route: req.originalUrl,
      method: req.method,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      ip: actor.ip,
      userId: actor.userId,
      rid,
    });

    recordGlobalRequestObservation({
      route: req.originalUrl,
      method: req.method,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });

  next();
});

const MAX_UPLOAD_BYTES = Number(
  process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024
);

const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || "./storage");
const SCAN_STORAGE_ROOT = path.join(STORAGE_ROOT, "scan");
const SCAN_ORIGINAL_ROOT = path.join(SCAN_STORAGE_ROOT, "original");
const SCAN_PROCESSED_ROOT = path.join(SCAN_STORAGE_ROOT, "processed");
const SCAN_THUMB_ROOT = path.join(SCAN_STORAGE_ROOT, "thumb");
const SCAN_EMBEDDING_ROOT = path.join(SCAN_STORAGE_ROOT, "embeddings");
const SCAN_MANIFEST_ROOT = path.join(SCAN_STORAGE_ROOT, "manifest");

const s3Client =
  OBJECT_STORE_PROVIDER === "s3" &&
  OBJECT_STORE_BUCKET &&
  OBJECT_STORE_ACCESS_KEY_ID &&
  OBJECT_STORE_SECRET_ACCESS_KEY
    ? new S3Client({
        region: OBJECT_STORE_REGION || "auto",
        endpoint: OBJECT_STORE_ENDPOINT || undefined,
        forcePathStyle: OBJECT_STORE_FORCE_PATH_STYLE,
        credentials: {
          accessKeyId: OBJECT_STORE_ACCESS_KEY_ID,
          secretAccessKey: OBJECT_STORE_SECRET_ACCESS_KEY,
        },
      })
    : null;

const PREPROCESS_MAX_EDGE = Number(process.env.PREPROCESS_MAX_EDGE || 1600);
const PREPROCESS_JPEG_QUALITY = Number(
  process.env.PREPROCESS_JPEG_QUALITY || 82
);

const BG_JOB_CONCURRENCY = Math.max(
  1,
  Number(process.env.BG_JOB_CONCURRENCY || 2)
);

const BG_JOB_MAX_AGE_MS = Number(
  process.env.BG_JOB_MAX_AGE_MS || 6 * 60 * 60 * 1000
);

// -------------------- Multer (images) --------------------
const upload = multer({
  storage: multer.memoryStorage(),
limits: {
  fileSize: MAX_UPLOAD_BYTES,
  files: 1
},
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(file.mimetype);
    cb(ok ? null : new Error("invalid_file_type"), ok);
  },
});

function extensionFromMime(mimetype = "") {
  const m = String(mimetype || "").toLowerCase();

  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("heic")) return "heic";
  if (m.includes("heif")) return "heif";

  return "bin";
}

function scanOriginalKey(imageHash, ext = "bin") {
  return `scan/original/${imageHash}.${ext}`;
}

function scanProcessedKey(imageHash) {
  return `scan/processed/${imageHash}.jpg`;
}

function scanThumbKey(imageHash) {
  return `scan/thumb/${imageHash}.jpg`;
}

function scanEmbeddingKey(imageHash) {
  return `scan/embeddings/${imageHash}.json`;
}

function scanManifestKey(imageHash) {
  return `scan/manifest/${imageHash}.json`;
}

function storagePathFromKey(key = "") {
  return path.join(STORAGE_ROOT, ...String(key).split("/"));
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(absPath) {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureScanStorage() {
  await Promise.all([
    ensureDir(SCAN_STORAGE_ROOT),
    ensureDir(SCAN_ORIGINAL_ROOT),
    ensureDir(SCAN_PROCESSED_ROOT),
    ensureDir(SCAN_THUMB_ROOT),
    ensureDir(SCAN_EMBEDDING_ROOT),
    ensureDir(SCAN_MANIFEST_ROOT),
  ]);
}

const scanStorageReady = ensureScanStorage();

function canUseS3ObjectStore() {
  return !!s3Client && !!OBJECT_STORE_BUCKET;
}

function guessMimeFromKey(key = "") {
  const lower = String(key || "").toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  if (lower.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function objectStorePublicUrl(key = "") {
  if (!key) return null;
  if (OBJECT_STORE_PUBLIC_BASE_URL) {
    return `${OBJECT_STORE_PUBLIC_BASE_URL}/${String(key).replace(/^\/+/, "")}`;
  }
  return null;
}

function normalizeObjectMetadata(metadata = {}) {
  const out = {};
  for (const [k, v] of Object.entries(metadata || {})) {
    if (v == null) continue;
    out[String(k).slice(0, 64)] = String(v).slice(0, 256);
  }
  return out;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function objectStorePutBuffer(
  key,
  buffer,
  contentType = "application/octet-stream",
  metadata = {}
) {
  if (canUseS3ObjectStore()) {
    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: OBJECT_STORE_BUCKET,
          Key: key,
          Body: buffer,
          ContentType: contentType,
          Metadata: normalizeObjectMetadata(metadata),
        })
      );
      return {
        key,
        url: objectStorePublicUrl(key),
        provider: "s3",
      };
    } catch (s3Err) {
      console.warn("⚠️ S3 put failed, falling back to local:", s3Err?.message || s3Err);
    }
  }

  await writeBufferIfMissing(key, buffer);
  return {
    key,
    url: objectStorePublicUrl(key),
    provider: "local",
  };
}

async function objectStoreReadBuffer(key) {
  if (!key) return null;

  try {
    if (canUseS3ObjectStore()) {
      const out = await s3Client.send(
        new GetObjectCommand({
          Bucket: OBJECT_STORE_BUCKET,
          Key: key,
        })
      );

      return await streamToBuffer(out.Body);
    }

    const absPath = storagePathFromKey(key);
    return await fs.readFile(absPath);
  } catch {
    return null;
  }
}

async function analyzeImageQuality(buffer) {
  try {
    const base = sharp(buffer, { failOn: "none" }).rotate();

    const metadata = await base.metadata().catch(() => ({}));
    const stats = await base.stats().catch(() => null);

    const tiny = await base
      .clone()
      .greyscale()
      .resize({
        width: 64,
        height: 64,
        fit: "inside",
        withoutEnlargement: true,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const raw = tiny.data || Buffer.from([]);
    const width = Number(tiny.info?.width || 0);
    const height = Number(tiny.info?.height || 0);

    let edgeSum = 0;
    let edgeCount = 0;

    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        const idx = y * width + x;
        const rightIdx = idx + 1;
        const downIdx = idx + width;

        edgeSum += Math.abs(raw[idx] - raw[rightIdx]);
        edgeSum += Math.abs(raw[idx] - raw[downIdx]);
        edgeCount += 2;
      }
    }

    const detailScore = edgeCount
      ? Math.max(0, Math.min(1, edgeSum / edgeCount / 32))
      : 0;

    const brightnessScore = stats?.channels?.[0]?.mean
      ? Math.max(0, Math.min(1, stats.channels[0].mean / 255))
      : null;

    const contrastScore = stats?.channels?.[0]?.stdev
      ? Math.max(0, Math.min(1, stats.channels[0].stdev / 64))
      : null;

    const likelyBlurry = detailScore < 0.07;
    const likelyDark = brightnessScore != null && brightnessScore < 0.16;
    const lowContrast = contrastScore != null && contrastScore < 0.10;

    return {
      width: metadata?.width || null,
      height: metadata?.height || null,
      format: metadata?.format || null,
      detailScore: round2(detailScore),
      brightnessScore: brightnessScore == null ? null : round2(brightnessScore),
      contrastScore: contrastScore == null ? null : round2(contrastScore),
      likelyBlurry,
      likelyDark,
      lowContrast,
      usable: !(likelyBlurry || likelyDark),
    };
  } catch {
    return {
      width: null,
      height: null,
      format: null,
      detailScore: null,
      brightnessScore: null,
      contrastScore: null,
      likelyBlurry: false,
      likelyDark: false,
      lowContrast: false,
      usable: true,
    };
  }
}

async function writeBufferIfMissing(key, buffer) {
  const absPath = storagePathFromKey(key);
  await ensureDir(path.dirname(absPath));

  if (!(await fileExists(absPath))) {
    await fs.writeFile(absPath, buffer);
  }

  return absPath;
}

async function writeJson(key, value) {
  const absPath = storagePathFromKey(key);
  await ensureDir(path.dirname(absPath));
  await fs.writeFile(absPath, JSON.stringify(value, null, 2), "utf8");
  return absPath;
}

async function readJson(key) {
  const absPath = storagePathFromKey(key);

  try {
    const raw = await fs.readFile(absPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function preprocessScanUpload(file) {
  const originalBuffer = Buffer.isBuffer(file?.buffer) ? file.buffer : null;

  if (!originalBuffer || !originalBuffer.length) {
    throw new Error("missing_upload_buffer");
  }

  try {
    const base = sharp(originalBuffer, { failOn: "none" }).rotate();

    const transformed = await base
      .clone()
      .resize({
        width: PREPROCESS_MAX_EDGE,
        height: PREPROCESS_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({
        quality: PREPROCESS_JPEG_QUALITY,
        mozjpeg: true,
      })
      .toBuffer({ resolveWithObject: true });

    const thumb = await base
      .clone()
      .resize({
        width: PREPROCESS_THUMB_EDGE,
        height: PREPROCESS_THUMB_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({
        quality: 76,
        mozjpeg: true,
      })
      .toBuffer({ resolveWithObject: true });

    const quality = await analyzeImageQuality(transformed.data);

    return {
      buffer: transformed.data,
      mimetype: "image/jpeg",
      thumbnailBuffer: thumb.data,
      thumbnailMime: "image/jpeg",
      quality,
      metadata: {
        width: transformed.info?.width || null,
        height: transformed.info?.height || null,
        channels: transformed.info?.channels || null,
        size: transformed.data.length,
        originalSize: originalBuffer.length,
        transformed: true,
        thumbnailSize: thumb.data.length,
      },
    };
  } catch (err) {
    console.warn(
      "⚠️ preprocessScanUpload failed, using original buffer",
      err?.message || err
    );

    const quality = await analyzeImageQuality(originalBuffer).catch(() => null);

    return {
      buffer: originalBuffer,
      mimetype: file?.mimetype || "application/octet-stream",
      thumbnailBuffer: null,
      thumbnailMime: null,
      quality,
      metadata: {
        width: null,
        height: null,
        channels: null,
        size: originalBuffer.length,
        originalSize: originalBuffer.length,
        transformed: false,
        thumbnailSize: 0,
      },
    };
  }
}

async function persistScanArtifacts(file, imageHash) {
  await scanStorageReady;

  const originalExt = extensionFromMime(file?.mimetype || "");
  const originalKey = scanOriginalKey(imageHash, originalExt);
  const processedKey = scanProcessedKey(imageHash);
  const thumbKey = scanThumbKey(imageHash);
  const manifestKey = scanManifestKey(imageHash);

  await objectStorePutBuffer(
    originalKey,
    file.buffer,
    file?.mimetype || "application/octet-stream",
    {
      imageHash,
      assetKind: "original",
    }
  );

  const processed = await preprocessScanUpload(file);

  await objectStorePutBuffer(
    processedKey,
    processed.buffer,
    processed.mimetype,
    {
      imageHash,
      assetKind: "processed",
    }
  );

  if (Buffer.isBuffer(processed.thumbnailBuffer) && processed.thumbnailBuffer.length) {
    await objectStorePutBuffer(
      thumbKey,
      processed.thumbnailBuffer,
      processed.thumbnailMime || "image/jpeg",
      {
        imageHash,
        assetKind: "thumb",
      }
    );
  }

  const manifest = {
    hash: imageHash,
    createdAt: Date.now(),
    objectStoreProvider: canUseS3ObjectStore() ? "s3" : "local",
    original: {
      key: originalKey,
      url: objectStorePublicUrl(originalKey),
      mimetype: file?.mimetype || null,
      size: Buffer.isBuffer(file?.buffer) ? file.buffer.length : 0,
    },
    processed: {
      key: processedKey,
      url: objectStorePublicUrl(processedKey),
      mimetype: processed.mimetype,
      size: processed.metadata?.size || processed.buffer.length,
      width: processed.metadata?.width || null,
      height: processed.metadata?.height || null,
      transformed: !!processed.metadata?.transformed,
    },
    thumbnail: {
      key:
        Buffer.isBuffer(processed.thumbnailBuffer) && processed.thumbnailBuffer.length
          ? thumbKey
          : null,
      url:
        Buffer.isBuffer(processed.thumbnailBuffer) && processed.thumbnailBuffer.length
          ? objectStorePublicUrl(thumbKey)
          : null,
      size: processed.metadata?.thumbnailSize || 0,
    },
    quality: processed.quality || null,
  };

  await writeJson(manifestKey, manifest);

  return {
    imageHash,
    asset: {
      hash: imageHash,
      originalKey,
      processedKey,
      thumbKey:
        Buffer.isBuffer(processed.thumbnailBuffer) && processed.thumbnailBuffer.length
          ? thumbKey
          : null,
      manifestKey,
      originalUrl: objectStorePublicUrl(originalKey),
      processedUrl: objectStorePublicUrl(processedKey),
      thumbUrl:
        Buffer.isBuffer(processed.thumbnailBuffer) && processed.thumbnailBuffer.length
          ? objectStorePublicUrl(thumbKey)
          : null,
    },
    preprocess: {
      ...processed.metadata,
      quality: processed.quality || null,
    },
    processedBuffer: processed.buffer,
    processedMime: processed.mimetype,
  };
}

async function loadStoredEmbedding(imageHash) {
  if (!imageHash) return null;

  const redisKey = `scan_embedding:${imageHash}`;

  try {
    const cached = await cacheGet(redisKey);
    if (Array.isArray(cached?.vector) && cached.vector.length) {
      return cached.vector;
    }
  } catch {}

  const disk = await readJson(scanEmbeddingKey(imageHash));
  const vector = Array.isArray(disk?.vector) ? disk.vector : null;

  if (vector?.length) {
    try {
      await cacheSet(redisKey, { vector }, 7 * 24 * 60 * 60);
    } catch {}
    return vector;
  }

  return null;
}

async function saveStoredEmbedding(imageHash, vector) {
  if (!imageHash || !Array.isArray(vector) || !vector.length) return;

  const payload = {
    hash: imageHash,
    createdAt: Date.now(),
    dims: vector.length,
    vector,
  };

  await writeJson(scanEmbeddingKey(imageHash), payload);

  try {
    await cacheSet(`scan_embedding:${imageHash}`, { vector }, 7 * 24 * 60 * 60);
  } catch {}
}

async function getOrCreateStoredEmbedding(imageHash, buffer) {
  const existing = await loadStoredEmbedding(imageHash);
  if (existing?.length) return existing;

  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;

  const vector = await computeImageEmbedding(buffer);

  if (Array.isArray(vector) && vector.length) {
    await saveStoredEmbedding(imageHash, vector);
    return vector;
  }

  return null;
}

// -------------------- Tiny utils --------------------
function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

function withHardTimeout(promise, ms, label = "timeout") {
  let id;

  const killer = new Promise((_, reject) => {
    id = setTimeout(() => {
      const err = new Error(label);
      err.name = "AbortError";
      reject(err);
    }, ms);
  });

  return Promise.race([promise, killer]).finally(() => {
    clearTimeout(id);
  });
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function safeStr(s, max = 180) {
  if (typeof s !== "string") return "";
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

function normalizeQuery(q = "") {
  return String(q)
    .toLowerCase()
    // keep "used", "pre owned", "marketplace" because they are useful intent
    .replace(/\b(cheap|deal|best price|sale)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// -----------------------------------
// QUERY VARIANT ENGINE (Evan AI Brain)
// -----------------------------------
function buildQueryVariants(query = "") {
  const q = normalizeQuery(query);

  const variants = new Set();
  variants.add(q);

  // eyewear intelligence
  if (q.includes("orange")) {
    variants.add("orange lens glasses");
    variants.add("amber lens glasses");
    variants.add("orange blue light glasses");
  }

  if (q.includes("blue light")) {
    variants.add("gaming glasses");
    variants.add("computer glasses");
  }

  if (q.includes("wrap")) {
    variants.add("wraparound glasses");
    variants.add("sports glasses");
  }

  if (q.includes("glasses")) {
    variants.add(q.replace("glasses", "eyewear"));
  }

  return Array.from(variants).slice(0, 5);
}

// =====================================================
// SAFE FALLBACK MEMORY
// NOTE:
// Do NOT persist last-good scan identity globally across requests.
// That can leak one item's identity into a later unrelated scan.
// =====================================================
let LAST_GOOD_QUERY = null;
let LAST_GOOD_CATEGORY = null;

function rememberGoodQuery(_q) {
  // intentionally disabled to prevent cross-scan bleed
  return;
}

function isGarbageQuery(q) {
  const s = String(q || "").trim().toLowerCase();
  if (!s) return true;

  const junk = new Set([
    "item",
    "object",
    "product",
    "thing",
    "stuff",
    "consumer product",
    "unknown",
    "misc",
    "misc item",
    "general item",
  ]);

  return junk.has(s);
}

function inferVisionCategory(q) {
  const s = String(q || "").toLowerCase();

  // eyewear
  if (
    s.includes("glasses") ||
    s.includes("eyewear") ||
    s.includes("sunglasses") ||
    s.includes("frames") ||
    s.includes("eyeglass")
  ) return "eyewear";

  // headwear
  if (
    s.includes("hat") ||
    s.includes("cap") ||
    s.includes("snapback") ||
    s.includes("beanie")
  ) return "headwear";

  // footwear
  if (
    s.includes("shoe") ||
    s.includes("sneaker") ||
    s.includes("boot") ||
    s.includes("loafer") ||
    s.includes("heel") ||
    s.includes("trainer")
  ) return "footwear";

  // bags
  if (
    s.includes("bag") ||
    s.includes("backpack") ||
    s.includes("rucksack") ||
    s.includes("tote") ||
    s.includes("handbag") ||
    s.includes("purse")
  ) return "bags";

  // clothing
  if (
    s.includes("shirt") ||
    s.includes("hoodie") ||
    s.includes("jacket") ||
    s.includes("coat") ||
    s.includes("pants") ||
    s.includes("jeans") ||
    s.includes("shorts") ||
    s.includes("sweater")
  ) return "apparel";

  // electronics
  if (
    s.includes("headphones") ||
    s.includes("earbuds") ||
    s.includes("speaker") ||
    s.includes("monitor") ||
    s.includes("keyboard") ||
    s.includes("mouse")
  ) return "electronics";

  // watches
  if (
    s.includes("watch") ||
    s.includes("wristwatch")
  ) return "watch";

  return null;
}

function categoryFallback(category) {
  if (category === "eyewear") return "glasses";
  if (category === "headwear") return "hat";
  if (category === "footwear") return "shoes";
  if (category === "electronics") return "electronics";
  if (category === "apparel") return "clothing";
  return null;
}

function isWeakGenericVisionQuery(q, mode = "item") {
  if (mode !== "item") return false;

  const s = normalizeQuery(q || "");
  if (!s) return true;

  return new Set([
    "item",
    "object",
    "product",
    "thing",
    "consumer product",
    "glasses",
    "eyewear",
    "frames",
    "sunglasses",
    "hat",
    "shoes",
    "clothing",
    "electronics",
  ]).has(s);
}

function stabilizeVisionQuery(rawQuery, normalizedQuery, mode = "item") {
  if (mode !== "item") return normalizedQuery || rawQuery || null;

  const raw = normalizeQuery(rawQuery || "");
  const norm = normalizeQuery(normalizedQuery || "");

  if (raw && !isWeakGenericVisionQuery(raw, mode)) {
    if (!norm || isWeakGenericVisionQuery(norm, mode)) {
      return rawQuery;
    }
  }

  return normalizedQuery || rawQuery || null;
}

function normalizeVisionQuery(query, mode = "item") {
  if (mode !== "item") return query;

  const raw = normalizeQuery(query || "");
  if (!raw) return null;

  const q = raw;

  const hasBlue =
    q.includes("blue light") ||
    q.includes("blue-light") ||
    q.includes("computer glasses") ||
    q.includes("computer") ||
    q.includes("screen") ||
    q.includes("anti blue") ||
    q.includes("blue blocker") ||
    q.includes("block blue") ||
    q.includes("gaming glasses");

  const hasOrange =
    q.includes("orange") ||
    q.includes("amber") ||
    q.includes("yellow tint") ||
    q.includes("yellow lens") ||
    q.includes("amber lens") ||
    q.includes("orange lens");

  const hasClear =
    q.includes("clear") ||
    q.includes("clear lens");

  const hasSun =
    q.includes("sunglass") ||
    q.includes("shade") ||
    q.includes("shades") ||
    q.includes("uv") ||
    q.includes("uv400") ||
    q.includes("polarized") ||
    q.includes("sun ");

  const hasGlasses =
    q.includes("glasses") ||
    q.includes("eyewear") ||
    q.includes("frames") ||
    q.includes("spectacles") ||
    q.includes("eyeglass");

  const hasLensWord =
    q.includes("lens") ||
    q.includes("lenses") ||
    q.includes("tinted") ||
    q.includes("tint");

  const frameColor =
    q.includes("black") ? "black" :
    q.includes("brown") ? "brown" :
    q.includes("white") ? "white" :
    q.includes("clear frame") || q.includes("transparent frame") ? "clear frame" :
    q.includes("tortoise") || q.includes("tortoiseshell") ? "tortoise" :
    null;

  const descriptors = [];

  if (
    q.includes("oversized") ||
    q.includes("large frame") ||
    q.includes("big frame")
  ) {
    descriptors.push("oversized");
  }

  if (q.includes("oval")) descriptors.push("oval");
  if (q.includes("wrap")) descriptors.push("wraparound");
  if (q.includes("shield")) descriptors.push("shield");
  if (q.includes("aviator")) descriptors.push("aviator");
  if (q.includes("rectangle")) descriptors.push("rectangle");
  if (q.includes("round")) descriptors.push("round");
  if (q.includes("square")) descriptors.push("square");
  if (q.includes("wire")) descriptors.push("wire frame");
  if (q.includes("rimless")) descriptors.push("rimless");

  const stylePrefix = [frameColor, ...descriptors]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  let candidate = raw;

  if (hasOrange && hasBlue) {
    const base = hasLensWord
      ? "orange lens blue light glasses"
      : "orange blue light glasses";
    candidate = [stylePrefix, base].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  } else if (hasBlue) {
    candidate = [stylePrefix, "blue light glasses"]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } else if (hasSun) {
    if (hasOrange) {
      const base = hasLensWord ? "orange lens sunglasses" : "orange sunglasses";
      candidate = [stylePrefix, base].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    } else {
      candidate = [stylePrefix, "sunglasses"]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    }
  } else if (hasClear) {
    candidate = [stylePrefix, "clear lens glasses"]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } else if (hasOrange) {
    const base = hasLensWord ? "orange lens glasses" : "orange glasses";
    candidate = [stylePrefix, base].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  } else if (hasGlasses) {
    candidate = [stylePrefix, "glasses"]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // CRITICAL:
  // if normalization drops informative tokens (brand/model/detail),
  // keep the richer original query instead of flattening it.
  const rawTokens = titleTokens(raw);
  const candidateTokens = titleTokens(candidate);
  const candidateSet = new Set(candidateTokens);
  const droppedTokens = rawTokens.filter((tok) => !candidateSet.has(tok));

  const rawLooksDetailed = rawTokens.length >= 4;
  const candidateIsBroader = candidateTokens.length < rawTokens.length;

  if (
    candidate &&
    candidate !== raw &&
    rawLooksDetailed &&
    candidateIsBroader &&
    droppedTokens.length >= 1
  ) {
    return raw;
  }

  return candidate || raw;
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function resaleScore(items) {
  if (!items.length) return 0;
  const prices = items.map(i => i.price).filter((n) => typeof n === "number" && Number.isFinite(n));
  if (!prices.length) return 0;

  const spread = Math.max(...prices) - Math.min(...prices);
  const avg = prices.reduce((a,b)=>a+b,0)/prices.length;

  return spread / Math.max(avg, 1);
}

// -------------------- HUMAN INTUITION PRICING --------------------
function median(sorted) {
  const n = sorted.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(sorted, q) {
  const n = sorted.length;
  if (!n) return null;
  const pos = (n - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const a = sorted[base];
  const b = sorted[Math.min(base + 1, n - 1)];
  return a + (b - a) * rest;
}

// Returns: typicalLow/High (human range), dealScore (0-1), weirdness flag
function computeMarketIntuition(items, payingPrice = null) {
  const prices = (items || [])
    .map((i) => i?.totalPrice ?? i?.price)
    .filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  if (prices.length < 4) {
    return {
      median: prices.length ? prices[Math.floor(prices.length / 2)] : null,
      typicalLow: prices[0] ?? null,
      typicalHigh: prices[prices.length - 1] ?? null,
      dealScore: null,
      isWeirdPrice: false,
      reason: "not_enough_data",
    };
  }

  const q1 = quantile(prices, 0.25);
  const q3 = quantile(prices, 0.75);
  const med = median(prices);

  const iqr = Math.max((q3 ?? 0) - (q1 ?? 0), 0.01);
  const lowFence = (q1 ?? 0) - 1.5 * iqr;
  const highFence = (q3 ?? 0) + 1.5 * iqr;

  // Human “typical range” = clamp within fences
  const typical = prices.filter((p) => p >= lowFence && p <= highFence);
  const typicalLow = typical[0] ?? prices[0];
  const typicalHigh = typical[typical.length - 1] ?? prices[prices.length - 1];

  let dealScore = null;
  let isWeirdPrice = false;

  if (
    typeof payingPrice === "number" &&
    Number.isFinite(payingPrice) &&
    payingPrice > 0
  ) {
    // 1.0 = insanely good (bottom of typical), 0.0 = bad (above typicalHigh)
    const denom = Math.max(typicalHigh - typicalLow, 0.01);
    dealScore = 1 - (payingPrice - typicalLow) / denom;
    dealScore = clamp01(dealScore);

    isWeirdPrice =
      payingPrice < typicalLow * 0.55 ||
      payingPrice > typicalHigh * 1.8;
  }

  return {
    median: med,
    typicalLow,
    typicalHigh,
    dealScore,
    isWeirdPrice,
    reason: "ok",
  };
}

// -------------------- HUMAN DEAL VERDICT ENGINE --------------------
function buildLocalDealVerdict(intuition, visionConfidence = 0.5) {
  if (!intuition || intuition.reason !== "ok") {
    return {
      label: "UNKNOWN",
      emoji: "🤔",
      confidence: 0.35,
      reason: "Not enough market data yet",
    };
  }

  const score = intuition.dealScore;
  const weird = intuition.isWeirdPrice;

  const confidence = clamp01(
    (typeof score === "number" ? score : 0.5) * 0.65 +
      visionConfidence * 0.35
  );

  if (weird) {
    return {
      label: "RISKY",
      emoji: "⚠️",
      confidence,
      reason: "Price sits outside normal market range",
    };
  }

  if (score >= 0.82) {
    return {
      label: "STEAL",
      emoji: "🔥",
      confidence,
      reason: "Far below typical market pricing",
    };
  }

  if (score >= 0.62) {
    return {
      label: "GOOD DEAL",
      emoji: "🟢",
      confidence,
      reason: "Below average market value",
    };
  }

  if (score >= 0.40) {
    return {
      label: "FAIR",
      emoji: "👌",
      confidence,
      reason: "Within normal market range",
    };
  }

  return {
    label: "OVERPRICED",
    emoji: "💸",
    confidence,
    reason: "Above typical market pricing",
  };
}

global.metrics = {
  visionCalls: 0,
};

// --------------------------------------------------
// VISION RATE LIMIT COOLDOWN
// prevents infinite retry loops when OpenAI returns 429
// --------------------------------------------------
let VISION_COOLDOWN_UNTIL = 0;

function visionCoolingDown() {
  return Date.now() < VISION_COOLDOWN_UNTIL;
}

function triggerVisionCooldown(seconds = 60) {
  VISION_COOLDOWN_UNTIL = Date.now() + seconds * 1000;
  console.warn(`⚠️ Vision rate limited. Cooling down for ${seconds}s`);
}

// -------------------- Redis (production cache) --------------------
import Redis from "ioredis";

const redis =
  process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          return Math.min(times * 50, 2000);
        },
      })
    : null;

if (redis) {
  redis.on("connect", () => {
    setMetric("redis_up", 1, { instanceId: INSTANCE_ID });
    logEvent("info", "redis_connect", {});
  });

  redis.on("ready", () => {
    setMetric("redis_ready", 1, { instanceId: INSTANCE_ID });
    logEvent("info", "redis_ready", {});
  });

  redis.on("error", (err) => {
    setMetric("redis_up", 0, { instanceId: INSTANCE_ID });
    incMetric("redis_error_total", 1, {});
    pushOpsAlert(
      "redis_error",
      {
        error: err?.message || String(err),
      },
      60_000
    );
  });

  redis.on("end", () => {
    setMetric("redis_up", 0, { instanceId: INSTANCE_ID });
    pushOpsAlert("redis_connection_closed", {}, 60_000);
  });
} else {
  setMetric("redis_up", 0, { instanceId: INSTANCE_ID });

  if (IS_PROD && REDIS_REQUIRED_IN_PROD) {
    pushOpsAlert(
      "redis_missing",
      {
        reason: "REDIS_URL not configured in production",
      },
      60 * 60 * 1000
    );
  }
}

const leaderElection = createLeaderElection({
  redis,
  key: LEADER_ELECTION_KEY,
  instanceId: INSTANCE_ID,
  ttlMs: LEADER_TTL_MS,
  renewMs: LEADER_RENEW_MS,
  onChange: (leader) => {
    logEvent("info", "leader_state_changed", {
      leader,
      instanceId: INSTANCE_ID,
      role: SERVER_ROLE,
    });
  },
});

const distributedSingleflight = createDistributedSingleflight({
  redis,
  namespace: "evanai:singleflight:v1",
  instanceId: INSTANCE_ID,
  lockTtlMs: Math.max(DISTRIBUTED_LOCK_TTL_MS, 15_000),
  resultTtlSec: SINGLEFLIGHT_RESULT_TTL_SEC,
  waitMs: SINGLEFLIGHT_WAIT_MS,
  pollMs: Math.max(50, DISTRIBUTED_POLL_MS),
});

const sourceBudget = createSourceBudgetManager({
  redis,
  namespace: "evanai:budget:v1",
  budgets: {
    vision: {
      maxDailyUnits: Number(process.env.BUDGET_VISION_DAILY || 400_000),
      allow: { free: true, pro: true, internal: true },
    },
    ebay: {
      maxDailyUnits: Number(process.env.BUDGET_EBAY_DAILY || 900_000),
      allow: { free: true, pro: true, internal: true },
    },
    walmart: {
      maxDailyUnits: Number(process.env.BUDGET_WALMART_DAILY || 300_000),
      allow: { free: true, pro: true, internal: true },
    },
    bestbuy: {
      maxDailyUnits: Number(process.env.BUDGET_BESTBUY_DAILY || 250_000),
      allow: { free: true, pro: true, internal: true },
    },
    etsy: {
      maxDailyUnits: Number(process.env.BUDGET_ETSY_DAILY || 150_000),
      allow: { free: true, pro: true, internal: true },
    },
    serpapi: {
      maxDailyUnits: Number(process.env.BUDGET_SERPAPI_DAILY || 50_000),
      allow: { free: false, pro: true, internal: true },
    },
  },
});

async function runBudgetedSourceLane(
  source,
  runner,
  { plan = "free", costUnits = 1 } = {}
) {
  const allowed = await sourceBudget.canUse(source, { plan, costUnits });

  if (!allowed) {
    incMetric("source_budget_block_total", 1, {
      source,
      plan,
    });

    logEvent("warn", "source_budget_blocked", {
      source,
      plan,
      costUnits,
    });

    return [];
  }

  await sourceBudget.note(source, { costUnits });

  try {
    const out = await runner();
    return Array.isArray(out) ? out : [];
  } catch (err) {
    logEvent("warn", "source_lane_failed", {
      source,
      plan,
      error: err?.message || String(err),
    });
    return [];
  }
}

function shouldRunQueueWorkers() {
  return QUEUE_ENABLED && QUEUE_WORKERS_ENABLED && SERVER_ROLE !== "api";
}

function shouldRunSchedulers() {
  return SCHEDULERS_ENABLED && SERVER_ROLE !== "api" && leaderElection.isLeader();
}

async function cacheGet(key) {
  if (!redis) return null;

  try {
    const v = await redis.get(key);
    incrementMetric("redis_cache_get_total", {
      hit: v ? "1" : "0",
    });
    return v ? JSON.parse(v) : null;
  } catch (err) {
    incrementMetric("redis_cache_error_total", { op: "get" });

    Promise.resolve()
      .then(() =>
        emitOpsAlert(
          "redis_cache_error",
          {
            op: "get",
            key: safeStr(key, 140),
            reason: err?.message || String(err),
          },
          { severity: "error", skipRedis: true }
        )
      )
      .catch(() => {});

    return null;
  }
}

async function cacheSet(key, value, ttlSec = 3600) {
  if (!redis) return;

  try {
    await redis.setex(key, ttlSec, JSON.stringify(value));
    incrementMetric("redis_cache_set_total", {});
  } catch (err) {
    incrementMetric("redis_cache_error_total", { op: "set" });

    Promise.resolve()
      .then(() =>
        emitOpsAlert(
          "redis_cache_error",
          {
            op: "set",
            key: safeStr(key, 140),
            reason: err?.message || String(err),
          },
          { severity: "error", skipRedis: true }
        )
      )
      .catch(() => {});
  }
}

async function cacheDel(key) {
  if (!redis) return;

  try {
    await redis.del(key);
    incrementMetric("redis_cache_del_total", {});
  } catch (err) {
    incrementMetric("redis_cache_error_total", { op: "del" });

    Promise.resolve()
      .then(() =>
        emitOpsAlert(
          "redis_cache_error",
          {
            op: "del",
            key: safeStr(key, 140),
            reason: err?.message || String(err),
          },
          { severity: "error", skipRedis: true }
        )
      )
      .catch(() => {});
  }
}

const createDurableIdemMiddleware = createDurableIdempotencyMiddleware({
  redis,
  namespace: "evanai:idem:v2",
  defaultTtlSec: IDEMPOTENCY_TTL_SEC,
});

const createDurableUploadIdemMiddleware = createDurableIdempotencyMiddleware({
  redis,
  namespace: "evanai:idem:upload:v2",
  headerName: "x-upload-idempotency-key",
  defaultTtlSec: IDEMPOTENCY_TTL_SEC,
});

function retrievalSnapshotCacheKey(query = "") {
  return `retrieval:snapshot:${canonicalMarketQuery(query)}`;
}

function retrievalSearchCacheKey(query = "", limit = 24) {
  return `retrieval:search:${canonicalMarketQuery(query)}:${Number(limit || 24)}`;
}

async function invalidateRetrievalCaches(query = "") {
  const base = canonicalMarketQuery(query);
  if (!base) return;

  await cacheDel(retrievalSnapshotCacheKey(base));
  await cacheDel(retrievalSearchCacheKey(base, 12));
  await cacheDel(retrievalSearchCacheKey(base, 24));
  await cacheDel(retrievalSearchCacheKey(base, 40));
  await cacheDel(retrievalSearchCacheKey(base, 60));
}

async function getRetrievalSnapshotCached(query = "") {
  const key = retrievalSnapshotCacheKey(query);
  const cached = await cacheGet(key);
  if (cached?.items?.length) return cached;

  const live = await getQuerySnapshot(query);
  if (live?.items?.length) {
    await cacheSet(key, live, 300);
  }

  return live;
}

async function searchRetrievalIndexCached(query = "", limit = 24) {
  const key = retrievalSearchCacheKey(query, limit);
  const cached = await cacheGet(key);
  if (Array.isArray(cached)) return cached;

  const live = await searchRetrievalIndex(query, limit);
  if (Array.isArray(live) && live.length) {
    await cacheSet(key, live, 180);
  }

  return live;
}

const L2_STATE_REFRESH = new Map();

function shortHash(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

function stableStateKeyPart(value = "", max = 180) {
  return encodeURIComponent(String(value || "").trim().slice(0, max));
}

function mirrorStateWrite(cacheKey, value, ttlSec = STATE_MIRROR_TTL_SEC) {
  if (!redis) return;
  cacheSet(cacheKey, value, ttlSec).catch(() => {});
}

function scheduleRedisStateRefresh(cacheKey, apply, intervalMs = REDIS_STATE_REFRESH_MS) {
  if (!redis || !cacheKey || typeof apply !== "function") return;

  const now = Date.now();
  const meta = L2_STATE_REFRESH.get(cacheKey) || { at: 0, inflight: false };

  if (meta.inflight) return;
  if (now - meta.at < intervalMs) return;

  L2_STATE_REFRESH.set(cacheKey, { at: now, inflight: true });

  Promise.resolve()
    .then(() => cacheGet(cacheKey))
    .then((remote) => {
      if (remote != null) apply(remote);
    })
    .catch((err) => {
      logEvent("warn", "redis_state_refresh_failed", {
        cacheKey,
        error: err?.message || String(err),
      });
    })
    .finally(() => {
      L2_STATE_REFRESH.set(cacheKey, {
        at: Date.now(),
        inflight: false,
      });
    });
}

function distributedListTrim(list = [], maxAgeMs = 24 * 60 * 60 * 1000, maxItems = 512) {
  const now = Date.now();
  return (Array.isArray(list) ? list : [])
    .map((x) => Number(x || 0))
    .filter((x) => Number.isFinite(x) && now - x < maxAgeMs)
    .slice(-maxItems);
}

function sourceHealthCacheKey(source = "") {
  return `state:source_health:${stableStateKeyPart(String(source || "").toLowerCase())}`;
}

function sourceMemoryCacheKey(query = "") {
  return `state:source_memory:${stableStateKeyPart(normalizeQuery(query))}`;
}

function queryPulseCacheKey(query = "") {
  return `state:query_pulse:${stableStateKeyPart(canonicalMarketQuery(query))}`;
}

function inflightResultCacheKey(key = "") {
  return `state:inflight_result:${shortHash(key)}`;
}

function distributedLockCacheKey(key = "") {
  return `state:lock:${shortHash(key)}`;
}

const LOCAL_UPLOAD_TICKET_STORE = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, ticket] of LOCAL_UPLOAD_TICKET_STORE.entries()) {
    if (Number(ticket?.expiresAt || 0) <= now) {
      LOCAL_UPLOAD_TICKET_STORE.delete(id);
    }
  }
}, 60 * 1000).unref?.();

function uploadTicketCacheKey(id) {
  return `upload_ticket:${safeStr(id, 120)}`;
}

async function saveUploadTicket(ticket) {
  if (!ticket?.id) return;

  if (redis) {
    await cacheSet(uploadTicketCacheKey(ticket.id), ticket, DIRECT_UPLOAD_TTL_SEC);
    return;
  }

  LOCAL_UPLOAD_TICKET_STORE.set(ticket.id, ticket);
}

async function readUploadTicket(id) {
  if (!id) return null;

  if (redis) {
    return await cacheGet(uploadTicketCacheKey(id));
  }

  const ticket = LOCAL_UPLOAD_TICKET_STORE.get(id);
  if (!ticket) return null;
  if (Number(ticket.expiresAt || 0) <= Date.now()) {
    LOCAL_UPLOAD_TICKET_STORE.delete(id);
    return null;
  }
  return ticket;
}

async function deleteUploadTicket(id) {
  if (!id) return;

  if (redis) {
    await cacheDel(uploadTicketCacheKey(id));
    return;
  }

  LOCAL_UPLOAD_TICKET_STORE.delete(id);
}

async function createDirectUploadSession({
  userId,
  contentType,
  sizeBytes,
  filename = "",
} = {}) {
  const ext = extensionFromMime(contentType || guessMimeFromKey(filename) || "");
  const objectKey =
    `uploads/raw/${safeStr(userId || "anon", 64)}/` +
    `${Date.now()}_${crypto.randomBytes(8).toString("hex")}.${ext}`;

  if (canUseS3ObjectStore()) {
    const command = new PutObjectCommand({
      Bucket: OBJECT_STORE_BUCKET,
      Key: objectKey,
      ContentType: contentType || "application/octet-stream",
      Metadata: normalizeObjectMetadata({
        userId: userId || "anon",
        uploadType: "scan_raw",
      }),
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: PRESIGNED_UPLOAD_TTL_SEC,
    });

    return {
      provider: "s3",
      objectKey,
      uploadUrl,
      method: "PUT",
      headers: {
        "Content-Type": contentType || "application/octet-stream",
      },
      expiresInSec: PRESIGNED_UPLOAD_TTL_SEC,
      maxBytes: sizeBytes || MAX_UPLOAD_BYTES,
    };
  }

  const ticket = {
    id: `upl_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`,
    objectKey,
    userId: userId || null,
    contentType: contentType || "application/octet-stream",
    maxBytes: sizeBytes || MAX_UPLOAD_BYTES,
    createdAt: Date.now(),
    expiresAt: Date.now() + DIRECT_UPLOAD_TTL_SEC * 1000,
  };

  await saveUploadTicket(ticket);

  return {
    provider: "local",
    objectKey,
    uploadUrl: `/upload/direct/${ticket.id}`,
    method: "PUT",
    headers: {
      "Content-Type": ticket.contentType,
    },
    expiresInSec: DIRECT_UPLOAD_TTL_SEC,
    maxBytes: ticket.maxBytes,
    ticketId: ticket.id,
  };
}

// -------------------- REFERRAL ENGINE --------------------

const REFERRAL_BONUS_REWARD = 3;

function generateReferralCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function referralCodeKey(code) {
  return `referral:${safeStr(code, 32).toUpperCase()}`;
}

function referralOwnerKey(ownerId) {
  return `referral_owner:${safeStr(ownerId, 64)}`;
}

function referralUserKey(userId) {
  return `referral_user:${safeStr(userId, 64)}`;
}

async function createReferral(ownerId) {
  if (!redis) return null;

  const cleanOwnerId = safeStr(ownerId, 64);
  if (!cleanOwnerId) return null;

  const existingCode = await redis.get(referralOwnerKey(cleanOwnerId));
  if (existingCode) {
    const existingRecord = await redis.get(referralCodeKey(existingCode));
    if (existingRecord) return existingCode;
  }

  for (let i = 0; i < 8; i++) {
    const code = generateReferralCode();
    const codeKey = referralCodeKey(code);
    const exists = await redis.get(codeKey);
    if (exists) continue;

    const payload = {
      ownerId: cleanOwnerId,
      code,
      uses: 0,
      createdAt: Date.now(),
    };

    await redis
      .multi()
      .set(codeKey, JSON.stringify(payload))
      .set(referralOwnerKey(cleanOwnerId), code)
      .exec();

    return code;
  }

  return null;
}

async function getReferralByOwner(ownerId) {
  if (!redis) return null;

  const cleanOwnerId = safeStr(ownerId, 64);
  if (!cleanOwnerId) return null;

  const code = await redis.get(referralOwnerKey(cleanOwnerId));
  if (!code) return null;

  const raw = await redis.get(referralCodeKey(code));
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function redeemReferral({ code, userId, source = "manual" }) {
  if (!redis) return { ok: false, reason: "redis_unavailable" };

  const cleanCode = safeStr(code, 32).toUpperCase();
  const cleanUserId = safeStr(userId || "", 64);
  const cleanSource = safeStr(source || "manual", 24) || "manual";

  if (!cleanCode || !cleanUserId) {
    return { ok: false, reason: "sign_in_required" };
  }

  const raw = await redis.get(referralCodeKey(cleanCode));
  if (!raw) return { ok: false, reason: "invalid_code" };

  let referral = null;
  try {
    referral = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid_code" };
  }

  if (!referral?.ownerId) {
    return { ok: false, reason: "invalid_code" };
  }

  if (String(referral.ownerId) === String(cleanUserId)) {
    return { ok: false, reason: "self_referral_not_allowed" };
  }

  const existingUserRedeem = await redis.get(referralUserKey(cleanUserId));
  if (existingUserRedeem) {
    return { ok: false, reason: "already_redeemed" };
  }

  referral.uses = Number(referral.uses || 0) + 1;

  const redeemPayload = {
    code: cleanCode,
    ownerId: referral.ownerId,
    redeemedAt: Date.now(),
    source: cleanSource,
  };

  await redis
    .multi()
    .set(referralCodeKey(cleanCode), JSON.stringify(referral))
    .set(referralUserKey(cleanUserId), JSON.stringify(redeemPayload))
    .exec();

  return {
    ok: true,
    ownerId: referral.ownerId,
    code: cleanCode,
    uses: referral.uses,
    source: cleanSource,
  };
}

// -------------------- TTL cache (prevents memory leak) --------------------
class TTLCache {
  constructor({ ttlMs, maxSize }) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.map = new Map(); // key -> { v, exp }
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.exp < Date.now()) {
      this.map.delete(key);
      return null;
    }
    return hit.v;
  }
  set(key, value) {
    // basic prune if oversized
    if (this.map.size >= this.maxSize) this.prune(0.15);
    this.map.set(key, { v: value, exp: Date.now() + this.ttlMs });
    return value;
  }
  prune(fraction = 0.2) {
    const target = Math.floor(this.maxSize * (1 - fraction));
    if (this.map.size <= target) return;

    // remove expired first
    const now = Date.now();
    for (const [k, entry] of this.map) {
      if (entry.exp < now) this.map.delete(k);
    }
    if (this.map.size <= target) return;

    // then remove oldest insertion order
    while (this.map.size > target) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }
  size() {
    return this.map.size;
  }
}

// -------------------- In-flight dedupe (prevents stampede) --------------------
const inflight = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireDistributedLock(rawKey, ttlMs = DISTRIBUTED_LOCK_TTL_MS) {
  if (!redis) return null;

  const lockKey = distributedLockCacheKey(rawKey);
  const token = `${INSTANCE_ID}:${Date.now()}:${crypto.randomBytes(6).toString("hex")}`;

  try {
    const ok = await redis.set(lockKey, token, "PX", ttlMs, "NX");
    if (ok !== "OK") return null;

    return {
      lockKey,
      token,
    };
  } catch {
    return null;
  }
}

async function releaseDistributedLock(lock) {
  if (!redis || !lock?.lockKey || !lock?.token) return;

  try {
    await redis.eval(
      `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      end
      return 0
      `,
      1,
      lock.lockKey,
      lock.token
    );
  } catch {}
}

async function publishInflightResult(rawKey, payload, ok = true, error = null) {
  if (!redis) return;

  await cacheSet(
    inflightResultCacheKey(rawKey),
    {
      ok,
      payload: ok ? payload : null,
      error: ok ? null : String(error || "inflight_failed"),
      instanceId: INSTANCE_ID,
      ts: Date.now(),
    },
    Math.max(15, Math.ceil(DISTRIBUTED_WAIT_MS / 1000) + 5)
  );
}

async function waitForInflightResult(rawKey, maxWaitMs = DISTRIBUTED_WAIT_MS) {
  if (!redis) return { hit: false, payload: null };

  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    const shared = await cacheGet(inflightResultCacheKey(rawKey));

    if (shared?.ok === true) {
      return { hit: true, payload: shared.payload };
    }

    if (shared?.ok === false) {
      return { hit: false, payload: null };
    }

    await sleep(DISTRIBUTED_POLL_MS);
  }

  return { hit: false, payload: null };
}

async function withInflight(key, fn) {
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    let lock = null;

    try {
      if (redis) {
        lock = await acquireDistributedLock(`inflight:${key}`);

        if (!lock) {
          const shared = await waitForInflightResult(`inflight:${key}`);
          if (shared.hit) {
            incMetric("distributed_inflight_hit_total", 1, {});
            return shared.payload;
          }
        }
      }

      const result = await fn();

      if (redis) {
        await publishInflightResult(`inflight:${key}`, result, true, null);
      }

      return result;
    } catch (err) {
      if (redis) {
        await publishInflightResult(
          `inflight:${key}`,
          null,
          false,
          err?.message || String(err)
        );
      }
      throw err;
    } finally {
      inflight.delete(key);
      if (lock) {
        await releaseDistributedLock(lock);
      }
    }
  })();

  inflight.set(key, p);
  return p;
}

// -------------------- Caches --------------------
// Vision results: long-ish TTL; limited size
const visionCache = new TTLCache({ ttlMs: 24 * 60 * 60 * 1000, maxSize: 1200 });
// SERP caches: short TTL
const SERP_CACHE = new TTLCache({ ttlMs: 5 * 60 * 1000, maxSize: 1200 });
const RESEARCH_CACHE = new TTLCache({ ttlMs: 5 * 60 * 1000, maxSize: 1000 });
const LOCAL_CACHE = new TTLCache({ ttlMs: 10 * 60 * 1000, maxSize: 600 });

const EBAY_RENDER_CACHE = new TTLCache({
  ttlMs: 10 * 60 * 1000,
  maxSize: 300,
});

const EBAY_RENDER_SKIP_CACHE = new TTLCache({
  ttlMs: 2 * 60 * 1000,
  maxSize: 400,
});


const QUERY_LEARNING = new Map();
const INSTANT_SCAN_CACHE = new TTLCache({
  ttlMs: 2 * 60 * 60 * 1000,
  maxSize: 2500,
});
const QUERY_PULSE = new Map();

function rememberBetterQuery(original, improved) {
  const o = normalizeQuery(original);
  const i = normalizeQuery(improved);

  if (!o || !i || o === i) return;
  QUERY_LEARNING.set(o, i);
}

function scanFingerprint(query = "", variants = []) {
  const payload = {
    query: canonicalMarketQuery(query),
    variants: uniqueQueries(variants)
      .map((x) => canonicalMarketQuery(x))
      .filter(Boolean)
      .sort(),
  };

  return sha256(Buffer.from(JSON.stringify(payload))).slice(0, 24);
}

setInterval(() => {
  visionCache.prune();
  SERP_CACHE.prune();
  RESEARCH_CACHE.prune();
  LOCAL_CACHE.prune();
}, 60 * 1000);

const PHASE5_COUNTERS = new Map();
const PHASE5_LATENCIES = new Map();
const PHASE5_ALERTS_L1 = [];
const PHASE5_DRILLS_L1 = [];
const PHASE5_ALERT_DEDUPE = new Map();

const EDGE_COUNTER_L1 = new TTLCache({
  ttlMs: PHASE5_ABUSE_WINDOW_MS,
  maxSize: 12000,
});

function stableStringify(value) {
  const seen = new WeakSet();

  const sortValue = (input) => {
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return "[circular]";
    seen.add(input);

    if (Array.isArray(input)) {
      return input.map(sortValue);
    }

    return Object.keys(input)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortValue(input[key]);
        return acc;
      }, {});
  };

  try {
    return JSON.stringify(sortValue(value));
  } catch {
    return JSON.stringify({ value: "[unserializable]" });
  }
}

function metricKey(name, tags = {}) {
  const sortedTags = Object.keys(tags)
    .sort()
    .reduce((acc, key) => {
      acc[key] = tags[key];
      return acc;
    }, {});
  return `${name}|${stableStringify(sortedTags)}`;
}

function incrementMetric(name, tags = {}, value = 1) {
  const key = metricKey(name, tags);
  const prev = PHASE5_COUNTERS.get(key) || {
    name,
    tags,
    value: 0,
    updatedAt: 0,
  };

  prev.value += Number(value || 0);
  prev.updatedAt = Date.now();

  PHASE5_COUNTERS.set(key, prev);

  if (PHASE5_COUNTERS.size > PHASE5_METRIC_HISTORY_MAX) {
    const firstKey = PHASE5_COUNTERS.keys().next().value;
    if (firstKey) PHASE5_COUNTERS.delete(firstKey);
  }
}

function observeLatencyMetric(name, durationMs, tags = {}) {
  const key = metricKey(name, tags);
  const prev = PHASE5_LATENCIES.get(key) || {
    name,
    tags,
    count: 0,
    sum: 0,
    max: 0,
    min: Number.POSITIVE_INFINITY,
    updatedAt: 0,
  };

  const d = Number(durationMs || 0);

  prev.count += 1;
  prev.sum += d;
  prev.max = Math.max(prev.max, d);
  prev.min = Math.min(prev.min, d);
  prev.updatedAt = Date.now();

  PHASE5_LATENCIES.set(key, prev);

  if (PHASE5_LATENCIES.size > PHASE5_METRIC_HISTORY_MAX) {
    const firstKey = PHASE5_LATENCIES.keys().next().value;
    if (firstKey) PHASE5_LATENCIES.delete(firstKey);
  }
}

function logStructured(level = "info", event = "log", fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    apiVersion: API_VERSION,
    region: DEPLOY_REGION,
    deploymentColor: DEPLOYMENT_COLOR,
    ...fields,
  };

  const line = stableStringify(payload);

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

async function emitOpsAlert(kind, payload = {}, opts = {}) {
  if (!PHASE5_ALERTS_ENABLED) return null;

  const severity = String(opts.severity || "warn");
  const cooldownMs = Number(opts.cooldownMs || PHASE5_ALERT_COOLDOWN_MS);
  const dedupeSeed =
    stableStringify(opts.dedupe || payload || {}).slice(0, 500) || kind;
  const dedupeKey = `${kind}:${hashString(dedupeSeed)}`;
  const lastAt = Number(PHASE5_ALERT_DEDUPE.get(dedupeKey) || 0);

  if (Date.now() - lastAt < cooldownMs) {
    return null;
  }

  PHASE5_ALERT_DEDUPE.set(dedupeKey, Date.now());

  const alert = {
    id: `alert_${Date.now()}_${hashString(`${kind}:${Date.now()}`)}`,
    ts: Date.now(),
    kind,
    severity,
    region: DEPLOY_REGION,
    payload,
  };

  PHASE5_ALERTS_L1.unshift(alert);
  if (PHASE5_ALERTS_L1.length > PHASE5_ALERT_HISTORY_MAX) {
    PHASE5_ALERTS_L1.length = PHASE5_ALERT_HISTORY_MAX;
  }

  try {
    recordHardeningEvent(`ops_alert_${kind}`, {
      severity,
      region: DEPLOY_REGION,
      ...payload,
    });
  } catch {}

  if (redis && !opts.skipRedis) {
    try {
      await redis.lpush("ops:alerts", JSON.stringify(alert));
      await redis.ltrim("ops:alerts", 0, PHASE5_ALERT_HISTORY_MAX - 1);
    } catch {}
  }

  logStructured(severity === "error" ? "error" : "warn", "ops_alert", {
    kind,
    severity,
    payload,
  });

  return alert;
}

async function listOpsAlerts(limit = 50) {
  const max = Math.max(1, Math.min(200, Number(limit || 50)));

  if (redis) {
    try {
      const raw = await redis.lrange("ops:alerts", 0, max - 1);
      const parsed = raw
        .map((x) => safeJsonParse(x, null))
        .filter(Boolean);

      if (parsed.length) return parsed;
    } catch {}
  }

  return PHASE5_ALERTS_L1.slice(0, max);
}

async function recordOpsDrill(type, payload = {}) {
  const item = {
    id: `drill_${Date.now()}_${hashString(`${type}:${Date.now()}`)}`,
    ts: Date.now(),
    type,
    region: DEPLOY_REGION,
    payload,
  };

  PHASE5_DRILLS_L1.unshift(item);
  if (PHASE5_DRILLS_L1.length > PHASE5_ALERT_HISTORY_MAX) {
    PHASE5_DRILLS_L1.length = PHASE5_ALERT_HISTORY_MAX;
  }

  if (redis) {
    try {
      await redis.lpush("ops:drills", JSON.stringify(item));
      await redis.ltrim("ops:drills", 0, PHASE5_ALERT_HISTORY_MAX - 1);
    } catch {}
  }

  try {
    await ensureDir(PHASE5_OPS_ROOT);
    await writeJson(
      `ops/drill-${item.id}.json`,
      item
    );
  } catch {}

  logStructured("info", "ops_drill_recorded", {
    type,
    payload,
  });

  return item;
}

async function listOpsDrills(limit = 50) {
  const max = Math.max(1, Math.min(200, Number(limit || 50)));

  if (redis) {
    try {
      const raw = await redis.lrange("ops:drills", 0, max - 1);
      const parsed = raw
        .map((x) => safeJsonParse(x, null))
        .filter(Boolean);

      if (parsed.length) return parsed;
    } catch {}
  }

  return PHASE5_DRILLS_L1.slice(0, max);
}

function normalizeRouteForMetrics(route = "") {
  return String(route || "")
    .replace(/[0-9a-f]{8,}/gi, ":id")
    .replace(/\b\d+\b/g, ":n")
    .replace(/\/+/g, "/")
    .trim() || "/";
}

function getRequestActor(req) {
  const userId =
    safeStr(
      req.auth?.userId ||
        req.user?.id ||
        req.headers["x-user-id"] ||
        req.body?.userId ||
        req.query?.userId,
      64
    ) || null;

  const deviceId =
    safeStr(
      req.headers["x-device-id"] ||
        req.headers["x-install-id"] ||
        req.body?.deviceId ||
        req.body?.installId,
      120
    ) || null;

  const ip = getClientIp(req);
  const fingerprint = hashString(getClientFingerprint(req));

  return {
    userId,
    deviceId,
    ip,
    anonKey: `${ip}:${fingerprint}`,
  };
}

async function incrementSharedWindowCounter(key, windowMs = PHASE5_ABUSE_WINDOW_MS) {
  if (redis) {
    try {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.pexpire(key, windowMs);
      }
      return Number(count || 0);
    } catch (err) {
      Promise.resolve()
        .then(() =>
          emitOpsAlert(
            "redis_counter_error",
            {
              key: safeStr(key, 140),
              reason: err?.message || String(err),
            },
            { severity: "error", skipRedis: true }
          )
        )
        .catch(() => {});
    }
  }

  const current = Number(EDGE_COUNTER_L1.get(key) || 0) + 1;
  EDGE_COUNTER_L1.set(key, current);
  return current;
}

function phase5EdgeHeaders(req, res, next) {
  const global = getGlobalHealthSnapshot();
  const inboundTrace =
    safeStr(req.headers["x-trace-id"], 160) ||
    safeStr(req.headers["traceparent"], 200) ||
    null;

  req.inboundTrace = inboundTrace;
  req.edgeRegion =
    safeStr(req.headers["x-edge-region"], 60) ||
    safeStr(req.headers["x-region"], 60) ||
    null;

  res.setHeader("x-api-version", API_VERSION);
  res.setHeader("x-region", DEPLOY_REGION);
  res.setHeader("x-primary-region", PRIMARY_REGION);
  res.setHeader(
    "x-active-region",
    safeStr(global?.activeRegion || DEPLOY_REGION, 60) || DEPLOY_REGION
  );
  res.setHeader("x-deployment-color", DEPLOYMENT_COLOR);

  next();
}

async function phase5EdgeAbuseGuard(req, res, next) {
  try {
    if (shouldSkipInfraGuard(req)) return next();
    if (req.method === "OPTIONS") return next();

    const path = String(req.path || "");
    const isVision =
      path === "/vision/analyze" || path === "/api/vision/analyze";
    const isUpload =
      path === "/upload/image" || path === "/api/upload/image";
    const isWrite =
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.method !== "OPTIONS";

    if (!isVision && !isUpload && !isWrite) {
      return next();
    }

    const actor = getRequestActor(req);
    const routeKey = normalizeRouteForMetrics(path);

    const ipLimit = isUpload
      ? PHASE5_UPLOAD_IP_MAX
      : isVision
      ? PHASE5_SCAN_IP_MAX
      : PHASE5_WRITE_IP_MAX;

    const deviceLimit = isUpload
      ? PHASE5_UPLOAD_DEVICE_MAX
      : isVision
      ? PHASE5_SCAN_DEVICE_MAX
      : PHASE5_WRITE_DEVICE_MAX;

    const userLimit = isVision
      ? PHASE5_SCAN_USER_MAX
      : PHASE5_WRITE_USER_MAX;

    const counters = [];

    counters.push({
      key: `edge:abuse:ip:${routeKey}:${actor.ip}`,
      count: await incrementSharedWindowCounter(
        `edge:abuse:ip:${routeKey}:${actor.ip}`
      ),
      limit: ipLimit,
      reason: "ip_limit",
    });

    if (actor.deviceId) {
      counters.push({
        key: `edge:abuse:device:${routeKey}:${actor.deviceId}`,
        count: await incrementSharedWindowCounter(
          `edge:abuse:device:${routeKey}:${actor.deviceId}`
        ),
        limit: deviceLimit,
        reason: "device_limit",
      });
    }

    if (actor.userId) {
      counters.push({
        key: `edge:abuse:user:${routeKey}:${actor.userId}`,
        count: await incrementSharedWindowCounter(
          `edge:abuse:user:${routeKey}:${actor.userId}`
        ),
        limit: userLimit,
        reason: "user_limit",
      });
    } else if (isVision || isUpload) {
      counters.push({
        key: `edge:abuse:anon_scan:${routeKey}:${actor.anonKey}`,
        count: await incrementSharedWindowCounter(
          `edge:abuse:anon_scan:${routeKey}:${actor.anonKey}`
        ),
        limit: PHASE5_SCAN_ANON_MAX,
        reason: "anon_scan_limit",
      });
    }

    const violated = counters.find((x) => Number(x.count || 0) > Number(x.limit || 0));

    if (!violated) return next();

    incrementMetric("abuse_block_total", {
      route: routeKey,
      reason: violated.reason,
    });

    Promise.resolve()
      .then(() =>
        emitOpsAlert(
          "abuse_block",
          {
            route: routeKey,
            reason: violated.reason,
            count: violated.count,
            limit: violated.limit,
            ip: actor.ip,
            userId: actor.userId,
            deviceId: actor.deviceId,
          },
          { severity: "warn" }
        )
      )
      .catch(() => {});

    res.setHeader("Retry-After", "60");

    return res.status(429).json({
      ok: false,
      error: "abuse_limited",
      reason: violated.reason,
    });
  } catch (err) {
    Promise.resolve()
      .then(() =>
        emitOpsAlert(
          "abuse_guard_failed",
          {
            route: req.path,
            reason: err?.message || String(err),
          },
          { severity: "error", skipRedis: true }
        )
      )
      .catch(() => {});

    return next();
  }
}

function attachIdempotentResponseCapture(res, writer) {
  const oldJson = res.json;

  res.json = function (body) {
    Promise.resolve()
      .then(() => writer(Number(res.statusCode || 200), body))
      .catch(() => {});

    return oldJson.call(this, body);
  };
}

function createIdempotencyMiddleware(scope, ttlSec = IDEMPOTENCY_TTL_SEC) {
  return async function phase5Idempotency(req, res, next) {
    if (req.method !== "POST" || !redis) return next();

    const idempotencyKey = safeStr(req.headers["idempotency-key"], 120);
    if (!idempotencyKey) return next();

    const actor = getRequestActor(req);
    const actorKey = actor.userId || actor.deviceId || actor.anonKey || "anon";
    const bodyHash = hashString(stableStringify(req.body || {}));
    const redisKey = `idem:${scope}:${actorKey}:${idempotencyKey}`;

    try {
      const existingRaw = await redis.get(redisKey);
      const existing = safeJsonParse(existingRaw, null);

      if (existing?.bodyHash && existing.bodyHash !== bodyHash) {
        return res.status(409).json({
          ok: false,
          error: "idempotency_conflict",
        });
      }

      if (existing?.status === "done" && existing?.response) {
        res.setHeader("x-idempotent-replay", "1");
        return res.status(existing.httpStatus || 200).json(existing.response);
      }

      if (existing?.status === "inflight") {
        return res.status(409).json({
          ok: false,
          error: "idempotency_inflight",
        });
      }

      const claimed = await redis.set(
        redisKey,
        JSON.stringify({
          status: "inflight",
          bodyHash,
          startedAt: Date.now(),
        }),
        "EX",
        Math.min(ttlSec, 120),
        "NX"
      );

      if (claimed !== "OK") {
        const retryRaw = await redis.get(redisKey);
        const retryValue = safeJsonParse(retryRaw, null);

        if (retryValue?.status === "done" && retryValue?.response) {
          res.setHeader("x-idempotent-replay", "1");
          return res.status(retryValue.httpStatus || 200).json(retryValue.response);
        }

        return res.status(409).json({
          ok: false,
          error: "idempotency_inflight",
        });
      }

      attachIdempotentResponseCapture(res, async (httpStatus, responseBody) => {
        try {
          await redis.set(
            redisKey,
            JSON.stringify({
              status: "done",
              bodyHash,
              httpStatus,
              response: responseBody,
              finishedAt: Date.now(),
            }),
            "EX",
            ttlSec
          );
        } catch {}
      });

      return next();
    } catch (err) {
      Promise.resolve()
        .then(() =>
          emitOpsAlert(
            "idempotency_failed",
            {
              scope,
              reason: err?.message || String(err),
            },
            { severity: "error", skipRedis: true }
          )
        )
        .catch(() => {});

      return next();
    }
  };
}

function createUploadIdempotencyMiddleware(scope, ttlSec = IDEMPOTENCY_TTL_SEC) {
  return async function phase5UploadIdempotency(req, res, next) {
    if (req.method !== "POST" || !redis) return next();

    const idempotencyKey = safeStr(req.headers["idempotency-key"], 120);
    if (!idempotencyKey) return next();

    const fileHash = Buffer.isBuffer(req.file?.buffer) ? sha256(req.file.buffer) : null;
    if (!fileHash) return next();

    const actor = getRequestActor(req);
    const actorKey = actor.userId || actor.deviceId || actor.anonKey || "anon";

    const bodyHash = hashString(
      stableStringify({
        fileHash,
        mode: req.body?.mode || null,
        propContext: req.body?.propContext || null,
      })
    );

    const redisKey = `idem:${scope}:${actorKey}:${idempotencyKey}`;

    try {
      const existingRaw = await redis.get(redisKey);
      const existing = safeJsonParse(existingRaw, null);

      if (existing?.bodyHash && existing.bodyHash !== bodyHash) {
        return res.status(409).json({
          ok: false,
          error: "idempotency_conflict",
        });
      }

      if (existing?.status === "done" && existing?.response) {
        res.setHeader("x-idempotent-replay", "1");
        return res.status(existing.httpStatus || 200).json(existing.response);
      }

      if (existing?.status === "inflight") {
        return res.status(409).json({
          ok: false,
          error: "idempotency_inflight",
        });
      }

      const claimed = await redis.set(
        redisKey,
        JSON.stringify({
          status: "inflight",
          bodyHash,
          startedAt: Date.now(),
        }),
        "EX",
        ttlSec,
        "NX"
      );

      if (claimed !== "OK") {
        const retryRaw = await redis.get(redisKey);
        const retryValue = safeJsonParse(retryRaw, null);

        if (retryValue?.status === "done" && retryValue?.response) {
          res.setHeader("x-idempotent-replay", "1");
          return res.status(retryValue.httpStatus || 200).json(retryValue.response);
        }

        return res.status(409).json({
          ok: false,
          error: "idempotency_inflight",
        });
      }

      attachIdempotentResponseCapture(res, async (httpStatus, responseBody) => {
        try {
          await redis.set(
            redisKey,
            JSON.stringify({
              status: "done",
              bodyHash,
              httpStatus,
              response: responseBody,
              finishedAt: Date.now(),
            }),
            "EX",
            ttlSec
          );
        } catch {}
      });

      return next();
    } catch (err) {
      Promise.resolve()
        .then(() =>
          emitOpsAlert(
            "upload_idempotency_failed",
            {
              scope,
              reason: err?.message || String(err),
            },
            { severity: "error", skipRedis: true }
          )
        )
        .catch(() => {});

      return next();
    }
  };
}

function getPhase5MetricsSnapshot() {
  const counters = [...PHASE5_COUNTERS.values()]
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, PHASE5_METRIC_HISTORY_MAX);

  const latencies = [...PHASE5_LATENCIES.values()]
    .map((x) => ({
      ...x,
      avg: x.count > 0 ? Math.round((x.sum / x.count) * 100) / 100 : 0,
      min: Number.isFinite(x.min) ? x.min : 0,
    }))
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, PHASE5_METRIC_HISTORY_MAX);

  const mem = process.memoryUsage();
  const global = getGlobalHealthSnapshot();

  return {
    ts: Date.now(),
    region: DEPLOY_REGION,
    primaryRegion: PRIMARY_REGION,
    deploymentColor: DEPLOYMENT_COLOR,
    runtime: {
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
      heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      rssMb: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
      bgJobQueued: Array.isArray(BG_JOB_QUEUE) ? BG_JOB_QUEUE.length : 0,
      bgJobActive: Number(BG_JOB_ACTIVE || 0),
      redisEnabled: !!redis,
      openaiEnabled: !!openai,
    },
    global,
    counters,
    latencies,
  };
}

// -------------------- OpenAI client --------------------
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

initializeRetrievalCore()
  .then((stats) => {
    console.log("🧠 Retrieval core ready", stats);
  })
  .catch((err) => {
    console.warn("⚠️ Retrieval core init failed", err?.message || err);
  });

initializeIntelligenceLayer()
  .then((stats) => {
    console.log("📈 Intelligence layer ready", stats);
  })
  .catch((err) => {
    console.warn("⚠️ Intelligence layer init failed", err?.message || err);
  });

initializeProductScale()
  .then((stats) => {
    console.log("📦 Product scale ready", stats);
  })
  .catch((err) => {
    console.warn("⚠️ Product scale init failed", err?.message || err);
  });

initializeHardeningLayer()
  .then((stats) => {
    console.log("🛡️ Hardening layer ready", stats);
  })
  .catch((err) => {
    console.warn("⚠️ Hardening layer init failed", err?.message || err);
  });

initializeGlobalScaleLayer()
  .then((stats) => {
    console.log("🌍 Global scale layer ready", stats);
  })
  .catch((err) => {
    console.warn("⚠️ Global scale init failed", err?.message || err);
  });

app.use(phase5EdgeHeaders);
app.use(phase5EdgeAbuseGuard);

app.use((req, res, next) => {
  if (req.path === "/routes" || req.path.startsWith("/debug/")) {
    return requireOpsAccess(req, res, next);
  }

  return next();
});

// -------------------- Health --------------------
app.get("/health", (_req, res) => {
  const global = getGlobalHealthSnapshot();

  return res.status(200).json({
    ok: true,
    region: global.currentRegion,
    activeRegion: global.activeRegion,
    activeRegionStatus: global.activeRegionStatus,
    activeRegionHealthScore: global.activeRegionHealthScore,
    failoverCount: global.failoverCount,
  });
});

app.get("/ready", async (_req, res) => {
  let redisOk = true;
  let redisState = redis ? "ok" : "disabled";

  if (redis) {
    try {
      await redis.ping();
      redisState = "ok";
    } catch {
      redisOk = false;
      redisState = "error";
    }
  }

  const ready =
    !!openai &&
    (!IS_PROD || !REDIS_REQUIRED_IN_PROD || redisOk);

  const heapUsedMb = Number(
    (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)
  );

  setMetric("process_heap_used_mb", heapUsedMb, {
    instanceId: INSTANCE_ID,
  });

  return res.status(ready ? 200 : 503).json({
    ok: ready,
    instanceId: INSTANCE_ID,
queue: {
  enabled: QUEUE_ENABLED,
  backend: redis ? "redis" : "local",
},
    checks: {
      openai: !!openai,
      redis: redisState,
      redisRequiredInProd: REDIS_REQUIRED_IN_PROD,
      uptimeSec: Math.floor(process.uptime()),
      heapUsedMb,
    },
  });
});

app.get("/routes", (_req, res) => {
  const routes = [];
  const stack = app._router?.stack || [];
  for (const layer of stack) {
    if (layer?.route?.path) {
      const methods = Object.keys(layer.route.methods || {}).map((m) =>
        m.toUpperCase()
      );
      routes.push({ path: layer.route.path, methods });
    }
  }
  res.status(200).json({ ok: true, routes });
});

app.get("/pulse/top", (_req, res) => {
  try {
    return res.status(200).json({
      ok: true,
      items: getTopPulse(10),
    });
  } catch {
    return res.status(200).json({
      ok: true,
      items: [],
    });
  }
});

app.get("/debug/metrics", requireOpsAccess, (_req, res) => {
  return res.status(200).json({
    ok: true,
    instanceId: INSTANCE_ID,
    legacy: global.metrics,
    metrics: snapshotMetrics(),
    alerts: OPS_ALERTS.slice(0, 50),
    redisEnabled: !!redis,
  });
});

app.get("/debug/alerts", requireOpsAccess, (_req, res) => {
  return res.status(200).json({
    ok: true,
    instanceId: INSTANCE_ID,
    alerts: OPS_ALERTS.slice(0, 100),
  });
});

app.get("/debug/cache", (_req, res) => {
  res.status(200).json({
    ok: true,
    sizes: {
      visionCache: visionCache.size(),
      SERP_CACHE: SERP_CACHE.size(),
      RESEARCH_CACHE: RESEARCH_CACHE.size(),
      LOCAL_CACHE: LOCAL_CACHE.size(),
      inflight: inflight.size,
    },
  });
});

app.get("/debug/retrieval", async (req, res) => {
  try {
    const query = safeStr(req.query?.q, 220);

    const snapshot = query
      ? await getRetrievalSnapshotCached(query)
      : null;

    const hits = query
      ? await searchRetrievalIndexCached(query, 12)
      : [];

    return res.status(200).json({
      ok: true,
      stats: getRetrievalStats(),
      query: query || null,
      snapshotCount: Array.isArray(snapshot?.items) ? snapshot.items.length : 0,
      hits,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "retrieval_debug_failed",
      reason: err?.message || String(err),
    });
  }
});

app.get("/debug/source-health", (_req, res) => {
  const sources = {};

  for (const [key, value] of SOURCE_HEALTH.entries()) {
    sources[key] = {
      ...value,
      coolingDown: (value.cooldownUntil || 0) > Date.now(),
      cooldownMsLeft: Math.max(0, (value.cooldownUntil || 0) - Date.now()),
    };
  }

  res.status(200).json({
    ok: true,
    sources,
  });
});


app.get("/debug/intelligence", async (req, res) => {
  try {
    const query = safeStr(req.query?.q, 220);
    const normalized = normalizeQuery(query);

    const [priceHistory, soldComp] = normalized
      ? await Promise.all([
          getPriceHistorySummary(normalized),
          getSoldCompSummary(normalized),
        ])
      : [null, null];

    return res.status(200).json({
      ok: true,
      stats: getIntelligenceStats(),
      query: normalized || null,
      priceHistory,
      soldComp,
      watchSignals: normalized ? buildWatchSignals(normalized) : null,
      crawlerCandidates: getCrawlerQueueCandidates(12),
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "intelligence_debug_failed",
      reason: err?.message || String(err),
    });
  }
});

app.get("/debug/product-scale", async (req, res) => {
  try {
    const userId = safeStr(req.query?.userId, 64);
    const query = normalizeQuery(safeStr(req.query?.q, 220));
    const days = Math.max(1, Math.min(30, Number(req.query?.days || 7)));

    const [profile, notifications, analytics, snapshot] = await Promise.all([
      userId ? getUserProfile(userId) : Promise.resolve(null),
      userId ? listNotifications(userId, 20) : Promise.resolve([]),
      getAnalyticsSummary(days),
      query ? getPrecomputeSnapshot(query) : Promise.resolve(null),
    ]);

    return res.status(200).json({
      ok: true,
      stats: getProductScaleStats(),
      userId: userId || null,
      query: query || null,
      profile,
      notifications,
      analytics,
      snapshot,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "product_scale_debug_failed",
      reason: err?.message || String(err),
    });
  }
});

app.get("/debug/hardening", requireApiKey, async (req, res) => {
  try {
    const limit = Math.max(5, Math.min(100, Number(req.query?.limit || 25)));

    return res.status(200).json({
      ok: true,
      stats: getHardeningStats(),
      debug: getHardeningDebugSnapshot(limit),
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "hardening_debug_failed",
      reason: err?.message || String(err),
    });
  }
});

app.get("/debug/global-scale", requireApiKey, async (req, res) => {
  try {
    const limit = Math.max(5, Math.min(100, Number(req.query?.limit || 25)));

    return res.status(200).json({
      ok: true,
      stats: getGlobalScaleStats(),
      debug: getGlobalScaleDebugSnapshot(limit),
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "global_scale_debug_failed",
      reason: err?.message || String(err),
    });
  }
});

app.post(
  "/admin/global/failover",
  requireApiKey,
  createIdempotencyMiddleware("admin_global_failover"),
  async (req, res) => {
  try {
    const region = safeStr(req.body?.region, 60);
    const snapshot = await setActiveRegion(region, "manual");

    return res.status(200).json({
      ok: true,
      snapshot,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "global_failover_failed",
      reason: err?.message || String(err),
    });
  }
});

app.post(
  "/admin/global/replicate",
  requireApiKey,
  createIdempotencyMiddleware("admin_global_replicate"),
  async (req, res) => {
  try {
    const label = safeStr(req.body?.label, 40) || "manual";

    const roots = Array.isArray(req.body?.roots) && req.body.roots.length
      ? req.body.roots.map((x) => safeStr(x, 260)).filter(Boolean)
      : [
          "./storage/intelligence",
          "./storage/product-scale",
          "./storage/scan-pipeline",
          "./storage/retrieval-core",
          "./storage/queue",
          "./storage/vector-db",
          "./storage/listings-db",
          "./storage/search-index",
          "./storage/product-graph",
          "./storage/object-store",
          "./storage/hardening",
          "./intelligence-db",
        ];

    const snapshots = await replicateGlobalState({
      label,
      roots,
    });

    return res.status(200).json({
      ok: true,
      snapshots,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "global_replication_failed",
      reason: err?.message || String(err),
    });
  }
});

app.get("/admin/global/replications", requireApiKey, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 20)));
    const snapshots = await listReplicationSnapshots(limit);

    return res.status(200).json({
      ok: true,
      snapshots,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "global_replication_list_failed",
      reason: err?.message || String(err),
    });
  }
});

app.post(
  "/admin/backup/create",
  requireApiKey,
  createIdempotencyMiddleware("admin_backup_create"),
  async (req, res) => {
  try {
    const label = safeStr(req.body?.label, 40) || "manual";

    const roots = Array.isArray(req.body?.roots) && req.body.roots.length
      ? req.body.roots.map((x) => safeStr(x, 260)).filter(Boolean)
      : [
          "./storage/intelligence",
          "./storage/product-scale",
          "./storage/scan-pipeline",
          "./storage/retrieval-core",
          "./storage/queue",
          "./storage/vector-db",
          "./storage/listings-db",
          "./storage/search-index",
          "./storage/product-graph",
          "./storage/object-store",
          "./intelligence-db",
        ];

    const snapshot = await createBackupSnapshot({
      label,
      roots,
    });

    return res.status(200).json({
      ok: true,
      snapshot,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "backup_create_failed",
      reason: err?.message || String(err),
    });
  }
});

app.get("/admin/backup/list", requireApiKey, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 20)));
    const snapshots = await listBackupSnapshots(limit);

    return res.status(200).json({
      ok: true,
      snapshots,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "backup_list_failed",
      reason: err?.message || String(err),
    });
  }
});

function safeDecodeUrl(value) {
  try {
    return decodeURIComponent(String(value || "").trim());
  } catch {
    return String(value || "").trim();
  }
}

function unwrapGoogleishUrl(value) {
  const raw = safeDecodeUrl(value);
  if (!raw || !/^https?:\/\//i.test(raw)) return "";

  try {
    const u = new URL(raw);
    const host = String(u.hostname || "").toLowerCase();

    if (host.includes("google.")) {
      const redirected =
        u.searchParams.get("url") ||
        u.searchParams.get("q") ||
        u.searchParams.get("adurl");

      if (redirected && /^https?:\/\//i.test(redirected)) {
        return safeDecodeUrl(redirected);
      }
    }

    return raw;
  } catch {
    return raw;
  }
}

function urlHost(value) {
  try {
    return String(new URL(String(value || "")).hostname || "").toLowerCase();
  } catch {
    return "";
  }
}

function isGoogleSearchUrl(value) {
  try {
    const u = new URL(String(value || ""));
    const host = String(u.hostname || "").toLowerCase();
    const path = String(u.pathname || "").toLowerCase();

    return host.includes("google.") && path === "/search";
  } catch {
    return false;
  }
}

function isGoogleShoppingProductUrl(value) {
  try {
    const u = new URL(String(value || ""));
    const host = String(u.hostname || "").toLowerCase();
    const path = String(u.pathname || "").toLowerCase();

    if (!host.includes("google.")) return false;

    return (
      path.includes("/shopping/product/") ||
      path.startsWith("/shopping/product")
    );
  } catch {
    return false;
  }
}

function chooseBestListingUrl(it = {}) {
  const googleProductLink = unwrapGoogleishUrl(
    it.product_link ||
      it.product_page_url ||
      it.google_product_link ||
      it.google_shopping_product_link ||
      it.shopping_result_link ||
      null
  );

  const merchantLink = unwrapGoogleishUrl(
    it.offer_page_url ||
      it.offer_link ||
      it.merchant_link ||
      it.product_url ||
      it.url ||
      it.link ||
      null
  );

  const candidates = [
    googleProductLink,
    merchantLink,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate && isGoogleShoppingProductUrl(candidate)) {
      return {
        link: candidate,
        googleProductLink: candidate,
        merchantLink: merchantLink || null,
        linkVerified: true,
        linkKind: "google_product",
        linkHost: urlHost(candidate),
      };
    }
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isGoogleSearchUrl(candidate)) continue;

    return {
      link: candidate,
      googleProductLink: googleProductLink || null,
      merchantLink: merchantLink || null,
      linkVerified: true,
      linkKind: urlHost(candidate).includes("google.") ? "google_product" : "merchant",
      linkHost: urlHost(candidate),
    };
  }

  return {
    link: null,
    googleProductLink: googleProductLink || null,
    merchantLink: merchantLink || null,
    linkVerified: false,
    linkKind: "none",
    linkHost: null,
  };
}

// -------------------- Helpers: market normalize --------------------
function parsePriceNumber(price) {
  if (!price) return null;
  const n = Number(String(price).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normalizeItem(it) {
  const price =
    it.extracted_price ??
    parsePriceNumber(it.price) ??
    parsePriceNumber(it.price_string) ??
    parsePriceNumber(it.price_display);

  const shipping =
    it.extracted_shipping ??
    parsePriceNumber(it.shipping) ??
    parsePriceNumber(it.shipping_cost) ??
    null;

  const totalPrice =
    typeof price === "number" && Number.isFinite(price)
      ? price +
        (typeof shipping === "number" && Number.isFinite(shipping) ? shipping : 0)
      : null;

// Phase 2: record historical price memory
if (typeof totalPrice === "number" && Number.isFinite(totalPrice)) {
  recordPriceObservation(it.title || "", totalPrice);
}

  const source =
    it.source ||
    it.store_name ||
    it.store ||
    it.seller ||
    it.merchant_name ||
    it.merchant?.name ||
    it.vendor ||
    null;

  const bestLink = chooseBestListingUrl({
    product_link: it.product_link,
    product_page_url: it.product_page_url,
    google_product_link: it.google_product_link,
    google_shopping_product_link: it.google_shopping_product_link,
    shopping_result_link: it.shopping_result_link,
    offer_page_url: it.offer_page_url,
    offer_link: it.offer_link,
    merchant_link: it.merchant_link,
    product_url: it.product_url,
    url: it.url,
    link: it.link,
  });

return {
  title: it.title || null,
  __trustScore: moatTrustScore(it),
  __clusterScore: 0,
  embedding: null,
  visualScore: 0,
    price,
    shipping,
    totalPrice,
    price_display: it.price || it.price_string || null,
    source,

    link: bestLink.link || null,
    url: bestLink.link || null,
    buyLink: bestLink.link || null,
    googleProductLink: bestLink.googleProductLink || null,
    merchantLink: bestLink.merchantLink || null,
    linkVerified: !!bestLink.linkVerified,
    linkKind: bestLink.linkKind || "none",
    linkHost: bestLink.linkHost || null,

    image:
      it.thumbnail ||
      it.thumbnail_url ||
      it.serpapi_thumbnail ||
      it.image ||
      null,

    rating: typeof it.rating === "number" ? it.rating : null,
    reviews:
      typeof it.reviews === "number"
        ? it.reviews
        : typeof it.review_count === "number"
        ? it.review_count
        : null,
  };
}

function sortCheapest(items) {
  return [...items].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
}

function normalizeTitleKey(t = "") {
  return String(t)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(s = "") {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "new",
    "used",
    "vintage",
    "retro",
    "style",
    "rare",
    "sale",
    "best",
    "price",
    "a",
    "an",
    "of",
  ]);

  return normalizeTitleKey(s)
    .split(" ")
    .map((x) => x.trim())
    .filter((x) => x.length >= 3 && !stop.has(x));
}

function titleSimilarityLoose(a = "", b = "") {
  const A = titleTokens(a);
  const B = titleTokens(b);

  if (!A.length || !B.length) return 0;

  const setB = new Set(B);
  let hits = 0;

  for (const token of A) {
    if (setB.has(token)) hits++;
  }

  return hits / Math.max(A.length, B.length);
}

function sanitizeMarketplaceQuery(raw = "") {
  const base = normalizeQuery(String(raw || ""));
  if (!base) return "";

  const junk = new Set(["item", "object", "thing", "product", "listing"]);
  const seen = new Set();
  const out = [];

  for (const tok of base.split(" ").filter(Boolean)) {
    if (junk.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }

  return out.join(" ").trim();
}

function decodeHtmlEntities(s = "") {
  return String(s)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

function stripHtml(s = "") {
  return decodeHtmlEntities(String(s).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(s = "", re) {
  const m = String(s || "").match(re);
  return m?.[1] ? decodeHtmlEntities(m[1]) : "";
}

function extractSnippetPrice(s = "") {
  const m = String(s || "")
    .replace(/,/g, "")
    .match(/\$ ?(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

async function fetchHtmlPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  return await res.text();
}

let ebayBrowserPromise = null;

async function getEbayBrowser() {
  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
}

async function fetchEbayRenderedRows(query = "") {
  const q = sanitizeMarketplaceQuery(query);
  if (!q) return [];

   const renderKey = `ebay_render|${canonicalMarketQuery(q)}`;
  const skipKey = `ebay_render_skip|${canonicalMarketQuery(q)}`;

  const cachedRows = EBAY_RENDER_CACHE.get(renderKey);
  if (Array.isArray(cachedRows) && cachedRows.length) {
    return cachedRows;
  }

  if (EBAY_RENDER_SKIP_CACHE.get(skipKey)) {
    return [];
  }

  const browser = await getEbayBrowser();

  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 1200 },
    locale: "en-US",
  });

  try {
    const url =
      `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}` +
      `&LH_BIN=1&LH_PrefLoc=1&rt=nc`;

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForSelector("li.s-item", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const rows = await page.$$eval("li.s-item", (nodes) =>
      nodes.map((node) => {
        const title =
          node.querySelector("h3.s-item__title")?.textContent?.trim() ||
          node.querySelector(".s-item__title")?.textContent?.trim() ||
          "";

        const link =
          node.querySelector("a.s-item__link")?.href ||
          "";

        const priceText =
          node.querySelector(".s-item__price")?.textContent?.trim() ||
          "";

        return { title, link, priceText };
      })
    );

    const cleanedRows = rows
      .filter((row) => row.title && row.link && row.priceText)
      .slice(0, 80);

    if (cleanedRows.length) {
      EBAY_RENDER_CACHE.set(renderKey, cleanedRows);
    } else {
      EBAY_RENDER_SKIP_CACHE.set(skipKey, true);
    }

    return cleanedRows;

  } catch (e) {
    console.warn("fetchEbayRenderedRows failed", q, e?.message || e);
    EBAY_RENDER_SKIP_CACHE.set(skipKey, true);
    return [];
  } finally {
await page.close().catch(()=>{});
await browser.close().catch(()=>{});
  }
}

function buildRetrievalLanes(primaryQuery, modelVariants = [], identity = null) {

const base = normalizeQuery(primaryQuery);

const words = titleTokens(base);

const broad =
  words.length >= 3
    ? words.slice(0, 3).join(" ")
    : base;

  return {
    exact: [base],
    resale: [
      `${base} used`,
      `${broad} used`
    ],
    visual: [],
    rescue: [
      broad
    ]
  };
}

function parseEbaySearchHtml(html) {
  if (!html) return [];

  const rows = String(html)
.split(/class="s-item__wrapper"|class="s-item"/i)
    .slice(1);

  const items = [];

  for (const row of rows) {

const title =
  stripHtml(firstMatch(row, /class="s-item__title[^"]*"[^>]*>([\s\S]*?)<\/span>/i)) ||
  stripHtml(firstMatch(row, /role="heading"[^>]*>([\s\S]*?)<\/span>/i)) ||
  stripHtml(firstMatch(row, /<h3[^>]*>([\s\S]*?)<\/h3>/i));

    const link =
      decodeHtmlEntities(firstMatch(row, /class="s-item__link"[^>]+href="([^"]+)"/i)) ||
      decodeHtmlEntities(firstMatch(row, /<a[^>]+href="([^"]+)"/i));

    const priceText =
      firstMatch(row, /class="s-item__price[^"]*">([\s\S]*?)<\/span>/i) ||
      firstMatch(row, /\$[\d,.]+/);

    const price = extractSnippetPrice(priceText);

    if (!title || !link || !Number.isFinite(price)) continue;

    const item = normalizeItem({
      title,
      link,
      price: `$${price}`,
      source: "ebay",
      __fromMarketSearch: true
    });

    if (item?.title) items.push(item);
  }

  return items;
}

async function searchEbayBrowse(query = "") {
  const q = sanitizeMarketplaceQuery(query);
  if (!q || !hasEbayApi()) return [];

  const token = await getEbayAccessToken();
  if (!token) return [];

  const startedAt = Date.now();

  try {
    const params = new URLSearchParams({
      q,
      limit: "24",
      filter: "buyingOptions:{FIXED_PRICE}",
    });

    const r = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "X-EBAY-C-ENDUSERCTX": "contextualLocation=country=US,zip=10001",
        },
      }
    );

    if (!r.ok) {
      markSourceFailure("ebay_api", `http_${r.status}`);
      console.warn("⚠️ eBay Browse search failed:", r.status, "query=", q);
      return [];
    }

    const data = await r.json().catch(() => ({}));
    const raw = Array.isArray(data?.itemSummaries) ? data.itemSummaries : [];

    let items = raw
      .map((it, idx) => {
        const normalized = normalizeItem({
          title: it?.title || null,
          extracted_price: Number(it?.price?.value ?? null),
          extracted_shipping: Number(
            it?.shippingOptions?.[0]?.shippingCost?.value ?? 0
          ),
          source: "eBay",
          link: it?.itemAffiliateWebUrl || it?.itemWebUrl || null,
          thumbnail: it?.image?.imageUrl || null,
          rating: null,
          reviews: null,
        });

        return {
          ...normalized,
          condition: it?.condition || null,
          __fromMarketSearch: true,
          __serverRank: idx + 1,
          source: normalized.source || "eBay",
          linkVerified: Boolean(
            normalized?.url || normalized?.buyLink || normalized?.link
          ),
        };
      })
      .filter((it) => it?.title)
      .filter((it) => Number.isFinite(it?.totalPrice) || Number.isFinite(it?.price));

    items = dedupeSmart(items);
    markSourceSuccess("ebay_api", Date.now() - startedAt);

    return items.slice(0, 60);
  } catch (err) {
    markSourceFailure(
      "ebay_api",
      err?.name === "AbortError" ? "timeout" : "exception"
    );
    console.warn("⚠️ eBay Browse error:", err?.message || err);
    return [];
  }
}

async function fetchEbayListings(query = "") {
  console.log("🧪 EBAY LISTINGS START", query);

  const q = sanitizeMarketplaceQuery(query);
  if (!q) return { items: [] };

  let apiItems = await searchEbayBrowse(q).catch(() => []);

  if (apiItems.length) {
    apiItems = filterRelevantListings(q, apiItems);
    apiItems = trimPriceOutliers(apiItems);
    apiItems = intuitionFilter(apiItems);
    apiItems = dedupeSmart(apiItems);
    apiItems = sortByAbsoluteCheapest(apiItems, q).slice(0, 60);

    console.log("🧪 EBAY API ITEMS", q, apiItems.length);
    return { items: apiItems };
  }

  const words = titleTokens(q);
  const broad =
    words.length >= 4
      ? words.slice(0, 4).join(" ")
      : q;

  const attempts = uniqueQueries([
    q,
    `${q} used`,
    broad,
  ]).slice(0, 2);

  let merged = [];

  for (const attempt of attempts) {
    const rows = await ebayRenderConcurrency(() =>
      fetchEbayRenderedRows(attempt)
    );
    console.log("🧪 EBAY RAW ROWS", attempt, rows.length);

    const items = rows
      .map((row) =>
        normalizeItem({
          title: row.title,
          link: row.link,
          price: row.priceText,
          source: "ebay",
          __fromMarketSearch: true,
        })
      )
      .filter((it) => it?.title)
      .filter((it) => Number.isFinite(it?.totalPrice) || Number.isFinite(it?.price));

    console.log("🧪 EBAY NORMALIZED ITEMS", items.length);

    merged.push(...items);

    if (merged.length >= 80) break;
  }

  const strict = filterRelevantListings(q, merged);

  const relaxed = merged
    .map((it) => ({
      ...it,
      __rel: marketRelevanceScore(it, q),
    }))
    .filter((it) => Number(it.__rel || 0) >= 0.12)
    .sort((a, b) => Number(b.__rel || 0) - Number(a.__rel || 0));

  let items = strict.length >= 4 ? strict : relaxed;

  console.log("🧪 EBAY AFTER FILTER", items.length);

  items = trimPriceOutliers(items);
  items = dedupeSmart(items);
  items = sortByAbsoluteCheapest(items, q).slice(0, 60);

  return { items };
}

async function ebayAdapterSearch(query = "") {
  const result = await fetchEbayListings(query);
  return Array.isArray(result?.items) ? result.items : [];
}

async function bingBackupSearch(query = "") {
  const q = sanitizeMarketplaceQuery(query);
  if (!q) return [];

  const attempts = uniqueQueries([
    q,
    `${q} buy`,
    `${q} used`,
    `${q} price`,
  ]).slice(0, 4);

  let out = [];

  for (const attempt of attempts) {
    const html = await fetchHtmlPage(
      `https://www.bing.com/search?q=${encodeURIComponent(attempt)}`
    ).catch(() => "");

    const blocks = String(html || "")
      .split(/<li[^>]+class="[^"]*b_algo[^"]*"/i)
      .slice(1);

    for (const block of blocks) {
      const title = stripHtml(firstMatch(block, /<h2[^>]*>([\s\S]*?)<\/h2>/i));
      const link = decodeHtmlEntities(firstMatch(block, /<a[^>]+href="([^"]+)"/i));
      const snippet = stripHtml(firstMatch(block, /<p[^>]*>([\s\S]*?)<\/p>/i));
      const price = extractSnippetPrice(`${title} ${snippet}`);

      if (!title || !link) continue;
      if (!/^https?:\/\//i.test(link)) continue;

      const item = normalizeItem({
        title,
        link,
        price: Number.isFinite(price) ? `$${price}` : null,
        source: urlHost(link) || "bing",
        __fromMarketSearch: true,
      });

      if (item?.title) out.push(item);
    }

    if (out.length >= 40) break;
  }

  out = dedupeSmart(out)
    .map((it) => ({
      ...it,
      __rel: marketRelevanceScore(it, q),
    }))
    .filter((it) => Number(it.__rel || 0) >= 0.10);

  return out.slice(0, 24);
}

async function googleCseBackupSearch(query = "") {
  const q = sanitizeMarketplaceQuery(query);
  if (!q) return [];

  // no paid Google CSE dependency — use a second broad web pass
  return await bingBackupSearch(`${q} buy price`);
}

function marketRelevanceScore(item, query) {
  const title = String(item?.title || "");
  const q = String(query || "");

  if (!title || !q) return 0;

  const normTitle = normalizeTitleKey(title);
  const normQuery = normalizeTitleKey(q);

  const loose = titleSimilarityLoose(normTitle, normQuery);
  const exactPhrase = normTitle.includes(normQuery) ? 1 : 0;

  const qTokens = titleTokens(normQuery);
  const tTokens = new Set(titleTokens(normTitle));
  const coreHits = qTokens.filter((x) => tTokens.has(x)).length;
  const coreRatio = qTokens.length ? coreHits / qTokens.length : 0;

  const src = String(item?.source || "").toLowerCase();
  const marketplaceBonus = isMarketplaceSource(src) ? 0.10 : 0;
  const retailPenalty = isRetailSource(src) ? -0.12 : 0;

  const usedBonus =
    normTitle.includes("used") ||
    normTitle.includes("pre owned") ||
    normTitle.includes("pre-owned") ||
    normTitle.includes("secondhand") ||
    normTitle.includes("vintage") ||
    normTitle.includes("retro") ||
    normTitle.includes("y2k")
      ? 0.06
      : 0;

  const eyewearMode =
    normQuery.includes("glasses") ||
    normQuery.includes("eyewear") ||
    normQuery.includes("frames") ||
    normQuery.includes("sunglasses") ||
    normQuery.includes("lens");

  const wantsOrange =
    normQuery.includes("orange") ||
    normQuery.includes("amber") ||
    normQuery.includes("yellow");

  const wantsBlue =
    normQuery.includes("blue light") ||
    normQuery.includes("blue-light") ||
    normQuery.includes("computer") ||
    normQuery.includes("gaming") ||
    normQuery.includes("block blue") ||
    normQuery.includes("blue blocker") ||
    normQuery.includes("blue blocking") ||
    normQuery.includes("screen");

  const wantsWrap = normQuery.includes("wrap");

  const wantsSun =
    normQuery.includes("sunglass") ||
    normQuery.includes("shade") ||
    normQuery.includes("shades") ||
    normQuery.includes("uv") ||
    normQuery.includes("uv400") ||
    normQuery.includes("polarized");

  const wantsOversized =
    normQuery.includes("oversized") ||
    normQuery.includes("large frame") ||
    normQuery.includes("big frame");

  const fashionOrangeWrap = eyewearMode && wantsOrange && wantsWrap && !wantsBlue;

  const allowBlueFallback =
    fashionOrangeWrap &&
    !normQuery.includes("sunglasses") &&
    !normQuery.includes("polarized") &&
    !normQuery.includes("uv400") &&
    !normQuery.includes("uv ");

  const hasOrange =
    normTitle.includes("orange") ||
    normTitle.includes("amber") ||
    normTitle.includes("yellow");

  const hasBlue =
    normTitle.includes("blue light") ||
    normTitle.includes("blue-light") ||
    normTitle.includes("computer") ||
    normTitle.includes("gaming") ||
    normTitle.includes("block blue") ||
    normTitle.includes("blue blocker") ||
    normTitle.includes("blue blocking") ||
    normTitle.includes("screen") ||
    normTitle.includes("blokz");

  const hasWrap = normTitle.includes("wrap");

  const hasSun =
    normTitle.includes("sunglass") ||
    normTitle.includes("shade") ||
    normTitle.includes("shades") ||
    normTitle.includes("uv") ||
    normTitle.includes("uv400") ||
    normTitle.includes("polarized");

  const hasBlack = normTitle.includes("black");

  const hasOversized =
    normTitle.includes("oversized") ||
    normTitle.includes("large frame") ||
    normTitle.includes("big frame");

  const hasFashion =
    normTitle.includes("fashion") ||
    normTitle.includes("retro") ||
    normTitle.includes("vintage") ||
    normTitle.includes("y2k") ||
    normTitle.includes("oval");

  const hasSport =
    normTitle.includes("cycling") ||
    normTitle.includes("running") ||
    normTitle.includes("baseball") ||
    normTitle.includes("golf") ||
    normTitle.includes("ski") ||
    normTitle.includes("fishing") ||
    normTitle.includes("driving") ||
    normTitle.includes("motorcycle") ||
    normTitle.includes("sport") ||
    normTitle.includes("sports");

  let styleBonus = 0;

  if (eyewearMode) {
    if (wantsOrange) styleBonus += hasOrange ? 0.16 : -0.10;
    if (wantsWrap) styleBonus += hasWrap ? 0.12 : -0.08;
    if (wantsSun) styleBonus += hasSun ? 0.20 : -0.18;
    if (wantsOversized) styleBonus += hasOversized ? 0.10 : -0.04;

    if (wantsBlue) {
      styleBonus += hasBlue ? 0.18 : -0.08;
    } else if (hasBlue) {
      styleBonus += allowBlueFallback ? 0.06 : -0.22;
    }

    if (wantsSun && hasBlue) {
      styleBonus -= 0.20;
    }

    if (fashionOrangeWrap) {
      if (hasBlack) styleBonus += 0.10;
      if (hasOversized) styleBonus += 0.08;
      if (hasFashion) styleBonus += 0.08;
      if (hasSport) styleBonus -= 0.26;
    }
  }

  return clamp01(
    loose * 0.44 +
      coreRatio * 0.24 +
      exactPhrase * 0.14 +
      marketplaceBonus +
      retailPenalty +
      usedBonus +
      styleBonus
  );
}

function filterRelevantListings(query, items) {
  if (!Array.isArray(items)) return [];

  const q = normalizeTitleKey(query);

  const eyewearMode =
    q.includes("glasses") ||
    q.includes("eyewear") ||
    q.includes("frames") ||
    q.includes("sunglasses") ||
    q.includes("lens");

  const wantsOrange =
    q.includes("orange") ||
    q.includes("amber") ||
    q.includes("yellow");

  const wantsBlue =
    q.includes("blue light") ||
    q.includes("blue-light") ||
    q.includes("computer") ||
    q.includes("gaming") ||
    q.includes("block blue") ||
    q.includes("screen") ||
    q.includes("blue blocker") ||
    q.includes("blue blocking");

  const wantsWrap =
    q.includes("wrap") ||
    q.includes("shield");

  const wantsSun =
    q.includes("sunglass") ||
    q.includes("shade") ||
    q.includes("shades") ||
    q.includes("uv") ||
    q.includes("uv400") ||
    q.includes("polarized");

  const wantsOversized =
    q.includes("oversized") ||
    q.includes("large frame") ||
    q.includes("big frame");

  const wantsOakley = q.includes("oakley");

  const fashionOrangeWrap =
    eyewearMode &&
    wantsOrange &&
    wantsWrap &&
    wantsSun &&
    !wantsBlue;

  const allowBlueFallback =
    eyewearMode &&
    wantsOrange &&
    wantsWrap &&
    !wantsSun &&
    !wantsBlue;

  const scored = items
    .filter((it) => it?.title)
    .map((it) => ({
      ...it,
      __relevance: marketRelevanceScore(it, query),
    }))
    .sort((a, b) => Number(b.__relevance || 0) - Number(a.__relevance || 0));

  const preserved = scored.filter((it) => Number(it.__relevance || 0) >= 0.10);

  if (!eyewearMode) {
    const strong = preserved.filter((it) => Number(it.__relevance || 0) >= 0.56);
    const medium = preserved.filter((it) => Number(it.__relevance || 0) >= 0.40);

    if (strong.length >= 6) return strong.slice(0, 60);
    if (medium.length >= 6) return medium.slice(0, 60);
    return preserved.slice(0, 60);
  }

  const strict = preserved.filter((it) => {
    const title = normalizeTitleKey(it?.title || "");
    const src = String(it?.source || "").toLowerCase();

    const hasOrange =
      title.includes("orange") ||
      title.includes("amber") ||
      title.includes("yellow");

    const hasBlue =
      title.includes("blue light") ||
      title.includes("blue-light") ||
      title.includes("computer") ||
      title.includes("gaming") ||
      title.includes("block blue") ||
      title.includes("blue blocker") ||
      title.includes("blue blocking") ||
      title.includes("screen") ||
      title.includes("blokz");

    const hasWrap =
      title.includes("wrap") ||
      title.includes("shield") ||
      title.includes("sport");

    const hasSun =
      title.includes("sunglass") ||
      title.includes("shade") ||
      title.includes("shades") ||
      title.includes("uv") ||
      title.includes("uv400") ||
      title.includes("polarized");

    const hasOversized =
      title.includes("oversized") ||
      title.includes("large frame") ||
      title.includes("big frame");

    const hasSport =
      title.includes("cycling") ||
      title.includes("running") ||
      title.includes("baseball") ||
      title.includes("golf") ||
      title.includes("ski") ||
      title.includes("fishing") ||
      title.includes("driving") ||
      title.includes("motorcycle") ||
      title.includes("sport") ||
      title.includes("sports");

    const hasOakley = title.includes("oakley");

    const opticalRetailSource =
      src.includes("zenni") ||
      src.includes("firmoo") ||
      src.includes("eyebuydirect") ||
      src.includes("glassesusa") ||
      src.includes("optical") ||
      src.includes("arrowhead");

    const strongWrapSunCandidate =
      hasOrange &&
      (hasWrap || hasSport) &&
      hasSun;

    if (wantsOakley && !hasOakley && it.__relevance < 0.70) return false;
    if (wantsOrange && !hasOrange && it.__relevance < 0.58) return false;
    if (wantsWrap && !(hasWrap || hasSport) && it.__relevance < 0.54) return false;
    if (wantsSun && !hasSun && it.__relevance < 0.56) return false;
    if (wantsOversized && !hasOversized && it.__relevance < 0.58) return false;

    if (!wantsBlue && hasBlue && !allowBlueFallback && !hasSun && it.__relevance < 0.76) {
      return false;
    }

    if (wantsSun && hasBlue && !hasSun && it.__relevance < 0.80) {
      return false;
    }

    // IMPORTANT:
    // sporty wraparound sunglasses are valid for Oakley-style orange-lens scans.
    // do not over-kill them just because they look athletic.
    if (fashionOrangeWrap && hasSport && !strongWrapSunCandidate && it.__relevance < 0.70) {
      return false;
    }

    if (wantsSun && opticalRetailSource && !hasSun && it.__relevance < 0.82) {
      return false;
    }

    return true;
  });

  const strong = strict.filter((it) => Number(it.__relevance || 0) >= 0.46);
  const medium = strict.filter((it) => Number(it.__relevance || 0) >= 0.30);

  if (strong.length >= 3) return strong.slice(0, 60);
  if (medium.length >= 3) return medium.slice(0, 60);
  if (strict.length >= 1) return strict.slice(0, 60);

  return preserved.slice(0, 60);
}

function promoteQueryFromMarket(query, items = []) {
  const q = normalizeQuery(query);
  if (!q) return q;

  // IMPORTANT:
  // Do NOT auto-promote orange eyewear into blue-light queries.
  // That drift is exactly what caused Zenni / Blokz / optical pollution.
  return q;
}

function buildEtsyVariants(query) {
  const base = normalizeQuery(query);
  if (!base) return [];

  const isEyewear =
    /\b(glasses|eyewear|sunglasses|frames|eyeglass|lens)\b/i.test(base);

  const wantsOrange =
    base.includes("orange") ||
    base.includes("amber") ||
    base.includes("yellow");

  const wantsBlue =
    base.includes("blue light") ||
    base.includes("blue-light") ||
    base.includes("computer") ||
    base.includes("gaming") ||
    base.includes("block blue") ||
    base.includes("blue blocker") ||
    base.includes("blue blocking") ||
    base.includes("screen");

  const wantsWrap = base.includes("wrap");

  const out = new Set([base]);

  // Etsy / vintage angle
  out.add(`${base} vintage`);
  out.add(`${base} retro`);

  if (isEyewear) {
    out.add(`${base} y2k`);

    if (wantsOrange) {
      out.add(base.replace(/\borange lens\b/g, "amber lens"));
      out.add("orange lens glasses");
      out.add("amber lens glasses");
    }

    if (wantsOrange && wantsWrap && !wantsBlue) {
      out.add("orange wraparound sunglasses");
      out.add("orange tinted wraparound sunglasses");
      out.add("black wraparound orange lens sunglasses");
      out.add("y2k orange lens wraparound sunglasses");
    }

    if (wantsOrange && !wantsBlue && !wantsWrap) {
      out.add("orange lens sunglasses");
      out.add("black orange lens sunglasses");
    }

    if (wantsBlue) {
      out.add("orange blue light glasses");
      out.add("amber blue light glasses");
    }
  }

  return [...out]
    .map((x) => normalizeQuery(x))
    .filter(Boolean)
    .slice(0, 8);
}

function dedupeByLink(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const link = String(it?.link || "").trim();
    if (!link) continue;
    if (seen.has(link)) continue;
    seen.add(link);
    out.push(it);
  }
  return out;
}

function preferMarketplaceIfHealthy(items = [], query = "") {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return list;

  const enriched = list.map((it) => ({
    ...it,
    __relevance:
      Number(it?.__relevance) || marketRelevanceScore(it, query),
  }));

  const verified = enriched.filter((it) => it?.linkVerified !== false);

  const marketplace = verified.filter(
    (it) =>
      isMarketplaceSource(it?.source) &&
      Number(it.__relevance || 0) >= 0.26
  );

  if (marketplace.length >= 3) {
    return marketplace.slice(0, 60);
  }

  const strong = verified.filter(
    (it) => Number(it.__relevance || 0) >= 0.46
  );

  if (marketplace.length >= 1 && strong.length >= 4) {
    return dedupeSmart([...marketplace, ...strong]).slice(0, 60);
  }

  return verified.length >= 4 ? verified.slice(0, 60) : enriched.slice(0, 60);
}

function listingPriorityBucket(item, query = "") {
  const relevance = Number(
    item?.__relevance ?? marketRelevanceScore(item, query) ?? 0
  );

  const src = String(item?.source || "").toLowerCase();
  const title = normalizeTitleKey(item?.title || "");

  const marketplace =
    isMarketplaceSource(src) ||
    title.includes("used") ||
    title.includes("pre owned") ||
    title.includes("pre-owned") ||
    title.includes("secondhand") ||
    title.includes("vintage") ||
    title.includes("retro") ||
    title.includes("y2k");

  if (relevance >= 0.82) return marketplace ? 4 : 3;
  if (relevance >= 0.68) return marketplace ? 3 : 2;
  if (relevance >= 0.52) return marketplace ? 2 : 1;
  return 0;
}

function keepBestPriorityTier(items, query = "") {
  if (!Array.isArray(items) || !items.length) return [];

  const scored = items.map((it) => ({
    item: it,
    bucket: listingPriorityBucket(it, query),
  }));

  const maxBucket = Math.max(...scored.map((x) => x.bucket));

  const filtered =
    maxBucket >= 4
      ? scored.filter((x) => x.bucket >= 3).map((x) => x.item)
      : maxBucket >= 3
      ? scored.filter((x) => x.bucket >= 2).map((x) => x.item)
      : maxBucket >= 2
      ? scored.filter((x) => x.bucket >= 2).map((x) => x.item)
      : items;

  return filtered.length >= 4 ? filtered : items;
}

function sortByAbsoluteCheapest(items, query = "", identity = null) {
  const list = Array.isArray(items) ? [...items] : [];

  return list.sort((a, b) => {
    const aBucket = listingPriorityBucket(a, query);
    const bBucket = listingPriorityBucket(b, query);

    const aIdentity = identity ? listingIdentityScore(a, identity) : 0;
    const bIdentity = identity ? listingIdentityScore(b, identity) : 0;

    const aIdentityBucket =
      aIdentity >= 0.82 ? 3 :
      aIdentity >= 0.58 ? 2 :
      aIdentity >= 0.34 ? 1 : 0;

    const bIdentityBucket =
      bIdentity >= 0.82 ? 3 :
      bIdentity >= 0.58 ? 2 :
      bIdentity >= 0.34 ? 1 : 0;

    if (aIdentityBucket !== bIdentityBucket) {
      return bIdentityBucket - aIdentityBucket;
    }

    if (aBucket !== bBucket) {
      return bBucket - aBucket;
    }

    const aDeal = Number(a?.dealScore || 0);
    const bDeal = Number(b?.dealScore || 0);
    if (Math.abs(bDeal - aDeal) > 0.08) {
      return bDeal - aDeal;
    }

    const aVisual = Number(a?.visualScore ?? a?.__imageScore ?? 0);
    const bVisual = Number(b?.visualScore ?? b?.__imageScore ?? 0);
    if (Math.abs(bVisual - aVisual) > 0.05) {
      return bVisual - aVisual;
    }

    const aSeller = Number(a?.sellerScore || 0);
    const bSeller = Number(b?.sellerScore || 0);
    if (Math.abs(bSeller - aSeller) > 0.05) {
      return bSeller - aSeller;
    }

    const aTrust = Number(a?.trustModelScore ?? a?.__trustScore ?? 0);
    const bTrust = Number(b?.trustModelScore ?? b?.__trustScore ?? 0);
    if (Math.abs(bTrust - aTrust) > 0.05) {
      return bTrust - aTrust;
    }

    const aVerified = a?.linkVerified !== false ? 1 : 0;
    const bVerified = b?.linkVerified !== false ? 1 : 0;
    if (aVerified !== bVerified) {
      return bVerified - aVerified;
    }

    const ap =
      Number.isFinite(a?.totalPrice) ? a.totalPrice :
      Number.isFinite(a?.price) ? a.price :
      Infinity;

    const bp =
      Number.isFinite(b?.totalPrice) ? b.totalPrice :
      Number.isFinite(b?.price) ? b.price :
      Infinity;

    if (ap !== bp) {
      return ap - bp;
    }

    const ar = Number(a?.__relevance ?? marketRelevanceScore(a, query) ?? 0);
    const br = Number(b?.__relevance ?? marketRelevanceScore(b, query) ?? 0);

    if (Math.abs(br - ar) > 0.04) {
      return br - ar;
    }

    return bIdentity - aIdentity;
  });
}

function dedupeByLinkOrTitlePrice(items) {
  const seen = new Set();
  const out = [];

  for (const it of items) {
    const key =
      String(it?.link || "").trim() ||
      `${String(it?.title || "").toLowerCase().trim()}|${Number(it?.price || 0)}`;

    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }

  return out;
}

function extractVisualMatchQueries(matches = []) {
  if (!Array.isArray(matches)) return [];

  const out = [];

  for (const row of matches) {
    const candidates = [
      row?.query,
      row?.item?.query,
      row?.metadata?.query,
      row?.title,
      row?.item?.title,
      row?.metadata?.title,
      row?.label,
      row?.name,
    ];

    for (const candidate of candidates) {
      const q = normalizeQuery(candidate || "");
      if (!q || isGarbageQuery(q)) continue;
      out.push(q);
    }
  }

  return uniqueQueries(out).slice(0, 4);
}

// 🧠 SMART SELF-HEAL QUERY
function selfHealQuery(q) {
  const s = normalizeQuery(q);

  if (!s) return q;

  // remove overly specific noise
  return s
    .replace(/\b(vintage|rare|authentic|limited|collector)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalMarketQuery(q = "") {
  let s = selfHealQuery(normalizeQuery(q));

  if (!s) return "";

  s = s.replace(/\bamber\b/g, "orange");
  s = s.replace(/\byellow\b/g, "orange");
  s = s.replace(/\bcomputer glasses\b/g, "blue light glasses");
  s = s.replace(/\bgaming glasses\b/g, "blue light glasses");
  s = s.replace(/\beyewear\b/g, "glasses");
  s = s.replace(/\bframes\b/g, "glasses");
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

function isMarketplaceSource(src = "") {
  const s = String(src || "").toLowerCase();

  return (
    s.includes("ebay") ||
    s.includes("etsy") ||
    s.includes("mercari") ||
    s.includes("poshmark") ||
    s.includes("depop") ||
    s.includes("grailed") ||
    s.includes("offerup") ||
    s.includes("facebook") ||
    s.includes("marketplace") ||
    s.includes("vinted") ||
    s.includes("whatnot")
  );
}

function isRetailSource(src = "") {
  const s = String(src || "").toLowerCase();

  return (
    s.includes("zenni") ||
    s.includes("firmoo") ||
    s.includes("eyebuydirect") ||
    s.includes("glassesusa") ||
    s.includes("optical") ||
    s.includes("arrowhead") ||
    s.includes("forensics") ||
    s.includes("walmart") ||
    s.includes("target") ||
    s.includes("best buy") ||
    s.includes("amazon")
  );
}

function marketplaceSourceScore(src = "") {
  const s = String(src || "").toLowerCase();

  if (!s) return 1.0;
  if (isMarketplaceSource(s)) return 1.22;
  if (isRetailSource(s)) return 0.64;
  return 1.0;
}

function extractEyewearVisualTraits(q = "") {
  const s = normalizeQuery(q);

  const family =
    s.includes("sunglasses")
      ? "sunglasses"
      : s.includes("glasses") || s.includes("eyewear") || s.includes("frames")
      ? "glasses"
      : "glasses";

  const frameColor =
    s.includes("black")
      ? "black"
      : s.includes("brown")
      ? "brown"
      : s.includes("white")
      ? "white"
      : s.includes("clear frame") || s.includes("transparent frame")
      ? "clear frame"
      : s.includes("tortoise") || s.includes("tortoiseshell")
      ? "tortoise"
      : "";

  const lensColor =
    s.includes("orange")
      ? "orange"
      : s.includes("amber")
      ? "amber"
      : s.includes("yellow")
      ? "yellow"
      : s.includes("clear lens") || s.includes("clear")
      ? "clear"
      : "";

  const lensType =
    s.includes("blue light")
      ? "blue light"
      : s.includes("computer")
      ? "computer"
      : s.includes("gaming")
      ? "gaming"
      : s.includes("polarized")
      ? "polarized"
      : s.includes("uv400")
      ? "uv400"
      : s.includes("tinted")
      ? "tinted"
      : lensColor
      ? "lens"
      : "";

  const shape =
    s.includes("wraparound")
      ? "wraparound"
      : s.includes("wrap")
      ? "wraparound"
      : s.includes("shield")
      ? "shield"
      : s.includes("aviator")
      ? "aviator"
      : s.includes("oval")
      ? "oval"
      : s.includes("round")
      ? "round"
      : s.includes("square")
      ? "square"
      : s.includes("rectangle")
      ? "rectangle"
      : "";

  const wantsSun =
    s.includes("sunglass") ||
    s.includes("shade") ||
    s.includes("shades") ||
    s.includes("uv") ||
    s.includes("uv400") ||
    s.includes("polarized");

  const wantsBlue =
    s.includes("blue light") ||
    s.includes("blue-light") ||
    s.includes("computer") ||
    s.includes("gaming") ||
    s.includes("block blue") ||
    s.includes("screen");

  return {
    s,
    family,
    frameColor,
    lensColor,
    lensType,
    shape,
    wantsSun,
    wantsBlue,
  };
}

function buildExactVisualSearchLadder(primaryQuery = "", extraVariants = []) {
  const primary = normalizeQuery(primaryQuery);
  if (!primary) return [];

  const out = [];
  const push = (...parts) => {
    const value = parts
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (value) out.push(value);
  };

  const t = extractEyewearVisualTraits(primary);
  push(primary);

  for (const v of normalizeVariantList(extraVariants, primary, "item")) {
    push(v);
  }

  const isEyewear =
    t.s.includes("glasses") ||
    t.s.includes("eyewear") ||
    t.s.includes("frames") ||
    t.s.includes("sunglasses") ||
    t.s.includes("lens");

  if (isEyewear) {
    push(t.frameColor, t.shape, t.lensColor, t.lensType, t.family);
    push(t.frameColor, t.shape, t.lensColor, t.family);
    push(t.frameColor, t.lensColor, t.lensType, t.family);
    push(t.shape, t.lensColor, t.lensType, t.family);
    push(t.frameColor, t.lensColor, t.family);
    push(t.shape, t.lensColor, t.family);
    push(t.lensColor, t.lensType, t.family);

    if (t.lensColor === "orange" || t.lensColor === "amber" || t.lensColor === "yellow") {
      push(t.frameColor, t.shape, "orange lens", t.family);
      push(t.shape, "orange lens", t.family);
      push("orange lens", t.family);
      push("amber lens", t.family);
    }

    if (t.wantsBlue) {
      push(t.frameColor, t.shape, "blue light", "glasses");
      push(t.shape, "blue light", "glasses");
      push(t.frameColor, "blue light", "glasses");
      push("computer", "glasses");
      push("gaming", "glasses");
    }

    if (t.wantsSun) {
      push(t.frameColor, t.shape, t.lensColor, "sunglasses");
      push(t.shape, t.lensColor, "sunglasses");
    }
  }

  return uniqueQueries(out).slice(0, 12);
}



function buildGoogleShoppingVariants(primaryQuery, extraVariants = []) {
  const base = normalizeQuery(primaryQuery);
  if (!base) return [];

  const ordered = [];
  const push = (q) => {
    const n = normalizeQuery(q);
    if (n) ordered.push(n);
  };

  const exactSeeds = buildExactVisualSearchLadder(base, extraVariants);
  for (const seed of exactSeeds) {
    push(seed);
  }

  const traits = extractEyewearVisualTraits(base);

  const isEyewear =
    traits.s.includes("glasses") ||
    traits.s.includes("eyewear") ||
    traits.s.includes("frames") ||
    traits.s.includes("lens") ||
    traits.s.includes("sunglasses");

  const fashionOrangeWrap =
    isEyewear &&
    (traits.lensColor === "orange" || traits.lensColor === "amber" || traits.lensColor === "yellow") &&
    traits.shape === "wraparound" &&
    !traits.wantsBlue;

  if (fashionOrangeWrap) {
    push("black wraparound orange lens sunglasses");
    push("orange wraparound sunglasses");
    push("orange lens wraparound sunglasses");
    push("y2k orange lens wraparound sunglasses");
  }

  if (traits.wantsBlue) {
    push("blue light glasses");
    push("computer glasses");
    push("gaming glasses");
  }

  for (const seed of exactSeeds.slice(0, 6)) {
    push(`${seed} used`);
    push(`${seed} marketplace`);
    push(`${seed} pre owned`);
  }

  return uniqueQueries(ordered).slice(0, 12);
}

function buildEmergencyShoppingFallbacks(primaryQuery = "", extraVariants = []) {
  const base = normalizeQuery(primaryQuery);
  if (!base) return [];

  const out = new Set([
    base,
    ...normalizeVariantList(extraVariants, base, "item"),
  ]);

  const category = inferVisionCategory(base);

  if (category === "eyewear") {
    const t = extractEyewearVisualTraits(base);

    if (t.frameColor && t.shape && t.family) {
      out.add(`${t.frameColor} ${t.shape} ${t.family}`);
    }

    if (t.shape && t.family) {
      out.add(`${t.shape} ${t.family}`);
    }

    if (t.frameColor && t.family) {
      out.add(`${t.frameColor} ${t.family}`);
    }

    if (t.lensColor && t.family) {
      out.add(`${t.lensColor} lens ${t.family}`);
    }

    if (t.lensColor === "orange" || t.lensColor === "amber" || t.lensColor === "yellow") {
      out.add("orange lens sunglasses");
      out.add("orange sunglasses");
    }

    if (t.shape === "oval") {
      out.add("oval sunglasses");
      out.add("retro oval sunglasses");
    }

    out.add("black oval sunglasses");
  }

// ---------- cheap deal discovery ----------
out.add(`${base} cheap`);
out.add(`${base} deal`);
out.add(`${base} clearance`);
out.add(`${base} auction`);
  return uniqueQueries([...out]).slice(0, 16);
}

const QUEUE_ENABLED =
  String(process.env.QUEUE_ENABLED || "true").toLowerCase() === "true";

const QUEUE_NAMESPACE = String(
  process.env.QUEUE_NAMESPACE || "evanai:queue:v1"
);

const QUEUE_IDLE_SLEEP_MS = Math.max(
  150,
  Number(process.env.QUEUE_IDLE_SLEEP_MS || 750)
);

const QUEUE_HEARTBEAT_MS = Math.max(
  1000,
  Number(process.env.QUEUE_HEARTBEAT_MS || 5000)
);

const QUEUE_VISIBILITY_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.QUEUE_VISIBILITY_TIMEOUT_MS || 60_000)
);

const QUEUE_DELAY_BASE_MS = Math.max(
  1000,
  Number(process.env.QUEUE_DELAY_BASE_MS || 4000)
);

const QUEUE_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.QUEUE_MAX_ATTEMPTS || 4)
);

const QUEUE_SWEEP_BATCH = Math.max(
  10,
  Number(process.env.QUEUE_SWEEP_BATCH || 50)
);

  const QUEUE_WORKER_CONCURRENCY = {
    scan:          Math.max(1, Number(process.env.QUEUE_SCAN_CONCURRENCY          || 2)),
    ingest:        Math.max(1, Number(process.env.QUEUE_INGEST_CONCURRENCY        || 2)),                                                                                                               
    ranking:       Math.max(1, Number(process.env.QUEUE_RANKING_CONCURRENCY       || 2)),                                                                                                               
    watchlist:     Math.max(1, Number(process.env.QUEUE_WATCHLIST_CONCURRENCY     || 1)),                                                                                                               
    notifications: Math.max(1, Number(process.env.QUEUE_NOTIFICATIONS_CONCURRENCY || 2)),                                                                                                               
    analytics:     Math.max(1, Number(process.env.QUEUE_ANALYTICS_CONCURRENCY     || 1)),                                                                                                             
    scan_replay:   Math.max(1, Number(process.env.QUEUE_SCAN_REPLAY_CONCURRENCY   || 1)),                                                                                                               
    autopilot:     Math.max(1, Number(process.env.QUEUE_AUTOPILOT_CONCURRENCY     || 1)),                                                                                                               
    default:       Math.max(1, Number(process.env.QUEUE_DEFAULT_CONCURRENCY       || 1)),                                                                                                               
  };           


  const QUEUE_TYPE_TO_TOPIC = {
    warm_scan_embedding:           "scan",                                                                                                                                                              
    store_scan_vector:             "scan",
    graph_ingest:                  "scan",                                                                                                                                                              
    counterfactual_scan:           "scan",                                                                                                                                                              
    retrieval_ingest:              "ingest",
    phase4_intelligence_ingest:    "ingest",                                                                                                                                                            
    phase4_crawler_refresh:        "ingest",                                                                                                                                                            
    phase4_internal_market_refresh:"ingest",
    phase5_precompute_save:        "ranking",                                                                                                                                                           
    phase5_precompute_refresh:     "ranking",                                                                                                                                                           
    notification_fanout:           "notifications",                                                                                                                                                     
    analytics_event:               "analytics",                                                                                                                                                         
    watch_refresh:                 "watchlist",                                                                                                                                                         
    scan_replay_record:            "scan_replay",                                                                                                                                                       
    scan_replay_analyze:           "scan_replay",                                                                                                                                                       
    autopilot_run:                 "autopilot",                                                                                                                                                         
  };                                               

const LOCAL_QUEUE_STATE = {
  jobs: new Map(),
  pending: new Map(),
  processing: new Map(),
  delayed: new Map(),
  dead: new Map(),
};

const QUEUE_HANDLER_REGISTRY = new Map();
let QUEUE_BACKBONE_STARTED = false;

function queueTopicForType(type = "default") {
  return QUEUE_TYPE_TO_TOPIC[type] || "default";
}

function queueKey(topic, kind) {
  return `${QUEUE_NAMESPACE}:${topic}:${kind}`;
}

function queueJobDocKey(jobId) {
  return `${QUEUE_NAMESPACE}:job:${safeStr(jobId, 120)}`;
}

function makeQueueJobId() {
  return `job_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
}

function queueResultPreview(result) {
  if (result == null) return null;

  if (typeof result === "string") {
    return result.slice(0, 400);
  }

  try {
    return JSON.stringify(result).slice(0, 400);
  } catch {
    return String(result).slice(0, 400);
  }
}

function computeQueueBackoffMs(attempts = 1) {
  return Math.min(
    5 * 60 * 1000,
    QUEUE_DELAY_BASE_MS * Math.pow(2, Math.max(0, Number(attempts || 1) - 1))
  );
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function redisCommand(args = []) {
  if (!redis) return null;

  if (typeof redis.sendCommand === "function") {
    return await redis.sendCommand(args);
  }

  if (typeof redis.call === "function") {
    return await redis.call(...args);
  }

  const method = String(args?.[0] || "").toLowerCase();
  if (method && typeof redis[method] === "function") {
    return await redis[method](...args.slice(1));
  }

  throw new Error("redis_command_not_supported");
}

function localQueueBucket(map, topic) {
  if (!map.has(topic)) map.set(topic, []);
  return map.get(topic);
}

async function saveQueueJobDoc(job) {
  if (!job?.id) return;

  if (redis) {
    await redis.set(queueJobDocKey(job.id), JSON.stringify(job), {
      EX: 7 * 24 * 60 * 60,
    });
    return;
  }

  LOCAL_QUEUE_STATE.jobs.set(job.id, job);
}

async function readQueueJobDoc(jobId) {
  if (!jobId) return null;

  if (redis) {
    const raw = await redis.get(queueJobDocKey(jobId));
    if (!raw) return null;

    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  return LOCAL_QUEUE_STATE.jobs.get(jobId) || null;
}

async function pushPendingJobId(topic, jobId) {
  if (!jobId) return;

  if (redis) {
    await redisCommand(["LPUSH", queueKey(topic, "pending"), jobId]);
    return;
  }

  localQueueBucket(LOCAL_QUEUE_STATE.pending, topic).unshift(jobId);
}

async function pushDeadJobId(topic, jobId) {
  if (!jobId) return;

  if (redis) {
    await redisCommand(["LPUSH", queueKey(topic, "dead"), jobId]);
    return;
  }

  localQueueBucket(LOCAL_QUEUE_STATE.dead, topic).unshift(jobId);
}

async function addDelayedJobId(topic, jobId, runAt) {
  if (!jobId) return;

  if (redis) {
    await redisCommand([
      "ZADD",
      queueKey(topic, "delayed"),
      String(runAt),
      jobId,
    ]);
    return;
  }

  const bucket = localQueueBucket(LOCAL_QUEUE_STATE.delayed, topic);
  bucket.push({ jobId, runAt: Number(runAt || Date.now()) });
}

async function claimNextQueueJob(topic) {
  if (redis) {
    const pendingKey = queueKey(topic, "pending");
    const processingKey = queueKey(topic, "processing");

    const jobId = await redisCommand(["RPOPLPUSH", pendingKey, processingKey]);
    if (!jobId) return null;

    const job = await readQueueJobDoc(jobId);
    if (!job) {
      await redisCommand(["LREM", processingKey, "1", jobId]);
      return null;
    }

    const next = {
      ...job,
      status: "running",
      attempts: Number(job.attempts || 0) + 1,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      updatedAt: Date.now(),
    };

    await saveQueueJobDoc(next);
    return next;
  }

  const pending = localQueueBucket(LOCAL_QUEUE_STATE.pending, topic);
  if (!pending.length) return null;

  const jobId = pending.pop();
  const processing = localQueueBucket(LOCAL_QUEUE_STATE.processing, topic);
  processing.unshift(jobId);

  const job = await readQueueJobDoc(jobId);
  if (!job) return null;

  const next = {
    ...job,
    status: "running",
    attempts: Number(job.attempts || 0) + 1,
    startedAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    updatedAt: Date.now(),
  };

  await saveQueueJobDoc(next);
  return next;
}

async function heartbeatQueueJob(jobId) {
  const current = await readQueueJobDoc(jobId);
  if (!current || current.status !== "running") return;

  current.lastHeartbeatAt = Date.now();
  current.updatedAt = Date.now();
  await saveQueueJobDoc(current);
}

async function acknowledgeQueueJob(jobId, result = null) {
  const current = await readQueueJobDoc(jobId);
  if (!current) return;

  const topic = current.topic || queueTopicForType(current.type);

  if (redis) {
    await redisCommand(["LREM", queueKey(topic, "processing"), "1", jobId]);
  } else {
    const processing = localQueueBucket(LOCAL_QUEUE_STATE.processing, topic);
    const idx = processing.indexOf(jobId);
    if (idx >= 0) processing.splice(idx, 1);
  }

  const next = {
    ...current,
    status: "completed",
    completedAt: Date.now(),
    updatedAt: Date.now(),
    resultPreview: queueResultPreview(result),
    lastError: null,
  };

  await saveQueueJobDoc(next);
  incMetric("queue_job_completed_total", 1, {
    topic,
    type: current.type || "unknown",
  });
}

async function failQueueJob(jobId, err, { forceDead = false } = {}) {
  const current = await readQueueJobDoc(jobId);
  if (!current) return;

  const topic = current.topic || queueTopicForType(current.type);

  if (redis) {
    await redisCommand(["LREM", queueKey(topic, "processing"), "1", jobId]);
  } else {
    const processing = localQueueBucket(LOCAL_QUEUE_STATE.processing, topic);
    const idx = processing.indexOf(jobId);
    if (idx >= 0) processing.splice(idx, 1);
  }

  const message = safeStr(err?.message || String(err || "job_failed"), 500);
  const attempts = Number(current.attempts || 0);
  const shouldDead = forceDead || attempts >= QUEUE_MAX_ATTEMPTS;

  if (shouldDead) {
    const deadJob = {
      ...current,
      status: "dead",
      updatedAt: Date.now(),
      completedAt: Date.now(),
      lastError: message,
    };

    await saveQueueJobDoc(deadJob);
    await pushDeadJobId(topic, jobId);

    incMetric("queue_job_dead_total", 1, {
      topic,
      type: current.type || "unknown",
    });

    pushOpsAlert(
      "queue_job_dead",
      {
        topic,
        type: current.type || "unknown",
        jobId,
        attempts,
        error: message,
      },
      10 * 60 * 1000
    );

    return;
  }

  const retryAt = Date.now() + computeQueueBackoffMs(attempts);

  const retriedJob = {
    ...current,
    status: "delayed",
    updatedAt: Date.now(),
    nextRunAt: retryAt,
    lastError: message,
  };

  await saveQueueJobDoc(retriedJob);
  await addDelayedJobId(topic, jobId, retryAt);

  incMetric("queue_job_retry_total", 1, {
    topic,
    type: current.type || "unknown",
  });
}

async function promoteDueDelayedJobs(topic) {
  if (redis) {
    const delayedKey = queueKey(topic, "delayed");
    const dueIds =
      (await redisCommand([
        "ZRANGEBYSCORE",
        delayedKey,
        "-inf",
        String(Date.now()),
        "LIMIT",
        "0",
        String(QUEUE_SWEEP_BATCH),
      ])) || [];

    for (const jobId of dueIds) {
      await redisCommand(["ZREM", delayedKey, jobId]);
      await pushPendingJobId(topic, jobId);

      const current = await readQueueJobDoc(jobId);
      if (current) {
        current.status = "queued";
        current.updatedAt = Date.now();
        await saveQueueJobDoc(current);
      }
    }

    return dueIds.length;
  }

  const delayed = localQueueBucket(LOCAL_QUEUE_STATE.delayed, topic);
  if (!delayed.length) return 0;

  const now = Date.now();
  const keep = [];
  let promoted = 0;

  for (const row of delayed) {
    if (Number(row?.runAt || 0) <= now) {
      await pushPendingJobId(topic, row.jobId);
      const current = await readQueueJobDoc(row.jobId);
      if (current) {
        current.status = "queued";
        current.updatedAt = Date.now();
        await saveQueueJobDoc(current);
      }
      promoted++;
    } else {
      keep.push(row);
    }
  }

  LOCAL_QUEUE_STATE.delayed.set(topic, keep);
  return promoted;
}

async function recoverStaleProcessingJobs(topic) {
  const now = Date.now();

  if (redis) {
    const ids =
      (await redisCommand([
        "LRANGE",
        queueKey(topic, "processing"),
        "0",
        String(Math.max(0, QUEUE_SWEEP_BATCH - 1)),
      ])) || [];

    let recovered = 0;

    for (const jobId of ids) {
      const current = await readQueueJobDoc(jobId);
      if (!current) {
        await redisCommand(["LREM", queueKey(topic, "processing"), "1", jobId]);
        continue;
      }

      if (current.status !== "running") continue;

      const heartbeatAge = now - Number(current.lastHeartbeatAt || current.startedAt || 0);
      if (heartbeatAge <= QUEUE_VISIBILITY_TIMEOUT_MS) continue;

      await failQueueJob(jobId, new Error("worker_visibility_timeout"));
      recovered++;
    }

    return recovered;
  }

  const ids = [...localQueueBucket(LOCAL_QUEUE_STATE.processing, topic)];
  let recovered = 0;

  for (const jobId of ids) {
    const current = await readQueueJobDoc(jobId);
    if (!current || current.status !== "running") continue;

    const heartbeatAge = now - Number(current.lastHeartbeatAt || current.startedAt || 0);
    if (heartbeatAge <= QUEUE_VISIBILITY_TIMEOUT_MS) continue;

    await failQueueJob(jobId, new Error("worker_visibility_timeout"));
    recovered++;
  }

  return recovered;
}

async function queueTopicStats(topic) {
  if (redis) {
    const pending = Number(
      (await redisCommand(["LLEN", queueKey(topic, "pending")])) || 0
    );
    const processing = Number(
      (await redisCommand(["LLEN", queueKey(topic, "processing")])) || 0
    );
    const dead = Number(
      (await redisCommand(["LLEN", queueKey(topic, "dead")])) || 0
    );
    const delayed = Number(
      (await redisCommand(["ZCARD", queueKey(topic, "delayed")])) || 0
    );

    return { pending, processing, delayed, dead };
  }

  return {
    pending: localQueueBucket(LOCAL_QUEUE_STATE.pending, topic).length,
    processing: localQueueBucket(LOCAL_QUEUE_STATE.processing, topic).length,
    delayed: localQueueBucket(LOCAL_QUEUE_STATE.delayed, topic).length,
    dead: localQueueBucket(LOCAL_QUEUE_STATE.dead, topic).length,
  };
}

function registerQueueHandler(type, handler) {
  if (!type || typeof handler !== "function") return;
  QUEUE_HANDLER_REGISTRY.set(type, handler);
}

function buildQueueJob(type, payload = {}) {
  const topic = queueTopicForType(type);

  return {
    id: makeQueueJobId(),
    type,
    topic,
    payload,
    status: "queued",
    attempts: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    completedAt: null,
    nextRunAt: Date.now(),
    lastHeartbeatAt: null,
    lastError: null,
  };
}

function enqueueBackgroundJob(type, payload = {}, worker = null) {
  if (!type) return null;

  if (typeof worker === "function") {
    registerQueueHandler(type, worker);
  }

  const job = buildQueueJob(type, payload);

  Promise.resolve()
    .then(async () => {
      await saveQueueJobDoc(job);
      await pushPendingJobId(job.topic, job.id);

      incMetric("queue_job_enqueued_total", 1, {
        topic: job.topic,
        type: job.type,
      });
    })
    .catch((err) => {
      logEvent("error", "queue_enqueue_failed", {
        type,
        topic: job.topic,
        jobId: job.id,
        error: err?.message || String(err),
      });
    });

  return job.id;
}

async function runQueueWorkerLoop(topic, workerName) {
  while (true) {
    try {
      await promoteDueDelayedJobs(topic);
      await recoverStaleProcessingJobs(topic);

      const job = await claimNextQueueJob(topic);
      if (!job) {
        await sleepMs(QUEUE_IDLE_SLEEP_MS);
        continue;
      }

      const handler = QUEUE_HANDLER_REGISTRY.get(job.type);

      if (typeof handler !== "function") {
        await failQueueJob(job.id, new Error(`missing_queue_handler:${job.type}`), {
          forceDead: true,
        });
        continue;
      }

      const heartbeat = setInterval(() => {
        heartbeatQueueJob(job.id).catch(() => {});
      }, QUEUE_HEARTBEAT_MS);

      heartbeat.unref?.();

      try {
        const result = await handler(job.payload, job);
        clearInterval(heartbeat);
        await acknowledgeQueueJob(job.id, result);
      } catch (err) {
        clearInterval(heartbeat);
        await failQueueJob(job.id, err);
      }
    } catch (err) {
      logEvent("error", "queue_worker_loop_failed", {
        topic,
        workerName,
        error: err?.message || String(err),
      });

      await sleepMs(Math.max(QUEUE_IDLE_SLEEP_MS, 1000));
    }
  }
}

function startQueueBackboneWorkers() {
  if (QUEUE_BACKBONE_STARTED || !QUEUE_ENABLED) return;
  QUEUE_BACKBONE_STARTED = true;

  for (const [topic, concurrency] of Object.entries(QUEUE_WORKER_CONCURRENCY)) {
    for (let i = 0; i < concurrency; i++) {
      const workerName = `${topic}:${i + 1}`;
      runQueueWorkerLoop(topic, workerName).catch((err) => {
        logEvent("error", "queue_worker_crashed", {
          topic,
          workerName,
          error: err?.message || String(err),
        });
      });
    }
  }
}

function queueAnalyticsEvent(payload = {}) {
  return enqueueBackgroundJob(
    "analytics_event",
    payload,
    async (jobPayload) => {
      await recordAnalyticsEventScaled(jobPayload);
      return {
        ok: true,
        event: jobPayload?.event || null,
        userId: jobPayload?.userId || null,
      };
    }
  );
}

function queueNotificationFanout(payload = {}) {
  return enqueueBackgroundJob(
    "notification_fanout",
    payload,
    async (jobPayload) => {
      await enqueueNotification(jobPayload);
      return {
        ok: true,
        kind: jobPayload?.kind || null,
        userId: jobPayload?.userId || null,
      };
    }
  );
}

function queueWatchRefresh(userId, query, extra = {}) {
  return enqueueBackgroundJob(
    "watch_refresh",
    {
      userId,
      query,
      extra,
    },
    async (jobPayload) => {
      const result = await runWatchCheck(jobPayload.userId, jobPayload.query);
      return {
        ok: !!result,
        query: jobPayload.query,
        bestPrice: result?.bestPrice ?? null,
      };
    }
  );
}


  function queueScanReplayRecord(replayData = {}) {
    return enqueueBackgroundJob(
      "scan_replay_record",
      replayData,
      async (payload) => {
        await recordScanReplay(redis, payload);
        return { ok: true, scanId: payload?.scanId || null };
      }
    );
  }

  function queueAutopilotRun(userId) {
    if (!userId) return null;
    return enqueueBackgroundJob(
      "autopilot_run",
      { userId },
      async (payload) => {
        const result = await runAutopilotForUser(redis, payload.userId, {
          listPortfolioItemsFn:    listPortfolioItems,
          computeLiquidityScoreFn: computeLiquidityScore,
          mergeCheapestSourcesFn:  mergeCheapestSources,
        });
        return { ok: true, count: result?.count ?? 0 };
      }
    );
  }


function scheduleRetrievalIngest(query = "", items = [], identity = null) {
  const q = normalizeQuery(query);
  const docs = Array.isArray(items) ? items.filter(Boolean).slice(0, 60) : [];

  if (!q || !docs.length) return null;

  return enqueueBackgroundJob(
    "retrieval_ingest",
    {
      query: q,
      items: docs,
      identity: identity || null,
    },
    async (payload) => {
      const snapshot = await upsertQuerySnapshot(payload.query, payload.items, {
        identity: payload.identity || null,
      });

      const graph = await upsertCanonicalProduct(payload.query, payload.items, {
        identity: payload.identity || null,
      });

      await invalidateRetrievalCaches(payload.query);

      return {
        ok: true,
        query: payload.query,
        snapshotItems: Array.isArray(snapshot?.items) ? snapshot.items.length : 0,
        graphListings: Array.isArray(graph?.listingIds) ? graph.listingIds.length : 0,
      };
    }
  );
}

const CRAWLER_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.CRAWLER_INTERVAL_MS || 180_000)
);

const CRAWLER_REFRESH_ACTIVE = new Set();
let CRAWLER_LOOP_STARTED = false;

function scheduleIntelligenceLayerIngest(query = "", items = [], identity = null) {
  const q = normalizeQuery(query);
  const docs = Array.isArray(items) ? items.filter(Boolean).slice(0, 60) : [];

  if (!q || !docs.length) return null;

  const worker = async () => {
    await Promise.all([
      recordPriceHistory(q, docs, { identity: identity || null }),
      recordSoldCompHistory(q, docs, { identity: identity || null }),
      recordCrawlerRefresh(q, docs, { reason: "market_ingest" }),
    ]);

    return {
      ok: true,
      query: q,
      count: docs.length,
    };
  };

  if (typeof enqueueBackgroundJob !== "function") {
    Promise.resolve()
      .then(worker)
      .catch((err) => {
        console.warn("phase4 intelligence ingest failed", err?.message || err);
      });
    return null;
  }

  return enqueueBackgroundJob(
    "phase4_intelligence_ingest",
    {
      query: q,
      count: docs.length,
    },
    worker
  );
}

function scheduleCrawlerRefresh(query = "", reason = "phase4_loop") {
  const q = normalizeQuery(query);
  if (!q) return null;
  if (CRAWLER_REFRESH_ACTIVE.has(q)) return null;

  const worker = async () => {
    CRAWLER_REFRESH_ACTIVE.add(q);

    try {
      const items = await mergeCheapestSources(q, [], null);
      await recordCrawlerRefresh(q, items, { reason });

      return {
        ok: true,
        query: q,
        count: Array.isArray(items) ? items.length : 0,
      };
    } finally {
      CRAWLER_REFRESH_ACTIVE.delete(q);
    }
  };

  if (typeof enqueueBackgroundJob !== "function") {
    Promise.resolve()
      .then(worker)
      .catch((err) => {
        console.warn("phase4 crawler refresh failed", err?.message || err);
      });
    return null;
  }

  return enqueueBackgroundJob(
    "phase4_crawler_refresh",
    {
      query: q,
      reason,
    },
    worker
  );
}

function startCrawlerExpansionLoop() {
  if (CRAWLER_LOOP_STARTED) return;
  CRAWLER_LOOP_STARTED = true;

  const timer = setInterval(() => {
    try {
      const candidates = getCrawlerQueueCandidates(4);

      for (const candidate of candidates) {
        if (candidate?.query) {
          scheduleCrawlerRefresh(candidate.query, "phase4_loop");
        }
      }
    } catch (err) {
      console.warn("phase4 crawler loop failed", err?.message || err);
    }
  }, CRAWLER_INTERVAL_MS);

  timer.unref?.();
}

const PRECOMPUTE_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.PRECOMPUTE_INTERVAL_MS || 240_000)
);

const PRECOMPUTE_ACTIVE = new Set();
let PRECOMPUTE_LOOP_STARTED = false;

function buildPhase5PrecomputePayload({
  query,
  finalQuery,
  searchedQueries = [],
  variants = [],
  uiItems = [],
  best = null,
  bestPrice = null,
  consensus = null,
  prediction = null,
  coach = null,
  pulse = null,
  intelligence = null,
  historical = null,
  marketHeat = null,
  visionIdentity = null,
} = {}) {
  return {
    query: normalizeQuery(query || ""),
    finalQuery: normalizeQuery(finalQuery || query || ""),
    searchedQueries: Array.isArray(searchedQueries) ? searchedQueries.slice(0, 12) : [],
    variants: Array.isArray(variants) ? variants.slice(0, 12) : [],
    bestPrice: finitePrice(bestPrice ?? best?.totalPrice ?? best?.price),
    best:
      best && typeof best === "object"
        ? {
            title: best?.title || null,
            source: best?.source || null,
            price: finitePrice(best?.totalPrice ?? best?.price),
            url: best?.url || best?.buyLink || best?.link || null,
            image: best?.image || null,
            dealScore: Number(best?.dealScore || 0),
            flipScore: Number(best?.flipScore || 0),
            sellerScore: Number(best?.sellerScore || 0),
            trust: Number(best?.trust || best?.trustModelScore || best?.__trustScore || 0),
          }
        : null,
    top: Array.isArray(uiItems)
      ? uiItems.slice(0, 8).map((it) => ({
          title: it?.title || null,
          source: it?.source || null,
          price: finitePrice(it?.totalPrice ?? it?.price),
          url: it?.url || it?.buyLink || it?.link || null,
          image: it?.image || null,
          dealScore: Number(it?.dealScore || 0),
          flipScore: Number(it?.flipScore || 0),
          sellerScore: Number(it?.sellerScore || 0),
          trust: Number(it?.trust || it?.trustModelScore || it?.__trustScore || 0),
        }))
      : [],
    consensus: consensus || null,
    prediction: prediction || null,
    coach: coach || null,
    pulse: pulse || null,
    intelligence: intelligence || null,
    historical: historical || null,
    marketHeat: marketHeat ?? null,
    visionIdentity: visionIdentity || null,
    itemCount: Array.isArray(uiItems) ? uiItems.length : 0,
  };
}

function schedulePhase5PrecomputeSave(payload = null) {
  const finalQuery = normalizeQuery(payload?.finalQuery || payload?.query || "");
  if (!finalQuery || !payload) return null;

  const worker = async () => {
    return await savePrecomputeSnapshot(
      finalQuery,
      buildPhase5PrecomputePayload(payload)
    );
  };

  if (typeof enqueueBackgroundJob !== "function") {
    Promise.resolve()
      .then(worker)
      .catch((err) => {
        console.warn("phase5 precompute save failed", err?.message || err);
      });
    return null;
  }

  return enqueueBackgroundJob(
    "phase5_precompute_save",
    {
      query: finalQuery,
    },
    worker
  );
}

function schedulePhase5PrecomputeRefresh(query = "", reason = "phase5_loop") {
  const q = normalizeQuery(query);
  if (!q) return null;
  if (PRECOMPUTE_ACTIVE.has(q)) return null;

  const worker = async () => {
    PRECOMPUTE_ACTIVE.add(q);

    try {
      const items = await mergeCheapestSources(q, [], null);
      const { uiItems, intelligence } = await buildFinalUiItemsWithIntelligence(q, items, {
        scannedPrice: null,
        visionConfidence: 0.5,
      });

      const consensus = buildMarketConsensus(uiItems, null, 0.5);
      const prediction = buildFlipPrediction({
        items: uiItems,
        scannedPrice: null,
        visionConfidence: 0.5,
        category: inferVisionCategory(q),
      });
      const coach = buildResaleCoach({
        prediction,
        consensus,
        scannedPrice: null,
        finalQuery: q,
      });
      const pulse = getPulse(q);

      const historical =
        getHistoricalStats(q) ||
        productStats(q) ||
        null;

      const best = uiItems[0] || null;
      const bestPrice = finitePrice(best?.totalPrice ?? best?.price);

      return await savePrecomputeSnapshot(
        q,
        buildPhase5PrecomputePayload({
          query: q,
          finalQuery: q,
          searchedQueries: [q],
          variants: [],
          uiItems,
          best,
          bestPrice,
          consensus,
          prediction,
          coach,
          pulse,
          intelligence,
          historical,
          marketHeat: marketHeat(q),
          visionIdentity: null,
        })
      );
    } finally {
      PRECOMPUTE_ACTIVE.delete(q);
    }
  };

  if (typeof enqueueBackgroundJob !== "function") {
    Promise.resolve()
      .then(worker)
      .catch((err) => {
        console.warn("phase5 precompute refresh failed", err?.message || err);
      });
    return null;
  }

  return enqueueBackgroundJob(
    "phase5_precompute_refresh",
    {
      query: q,
      reason,
    },
    worker
  );
}

function startPrecomputeLoop() {
  if (PRECOMPUTE_LOOP_STARTED) return;
  PRECOMPUTE_LOOP_STARTED = true;

  const timer = setInterval(() => {
    try {
      const candidates = getCrawlerQueueCandidates(5);

      for (const candidate of candidates) {
        if (candidate?.query) {
          schedulePhase5PrecomputeRefresh(candidate.query, "phase5_loop");
        }
      }
    } catch (err) {
      console.warn("phase5 precompute loop failed", err?.message || err);
    }
  }, PRECOMPUTE_INTERVAL_MS);

  timer.unref?.();
}

async function buildFinalUiItemsWithIntelligence(
  query,
  items,
  { scannedPrice = null, visionConfidence = 0.5 } = {}
) {
  const ranked = Array.isArray(items)
    ? rankVisualComps(query, items).slice(0, Math.min(items.length, 32))
    : [];

  const baseUiItems = ranked.map((it) => ({
    ...it,
    trust: moatTrustScore(it),
    url: it?.url || it?.buyLink || it?.link || null,
    buyLink: it?.buyLink || it?.url || it?.link || null,
  }));

  const enriched = await rerankWithIntelligence(query, baseUiItems, {
    scannedPrice,
    visionConfidence,
  }).catch(() => null);

  return {
    uiItems:
      Array.isArray(enriched?.items) && enriched.items.length
        ? enriched.items
        : baseUiItems,
    intelligence: enriched?.meta || null,
  };
}

async function mergeCheapestSources(query, extraVariants = [], identity = null) {

  const killTimer = new Promise((resolve) =>
    setTimeout(() => resolve("__timeout__"), 7000)
  );

  const worker = (async () => {

  let normalizedQuery = selfHealQuery(normalizeQuery(query));
  recordMarketActivity(normalizedQuery);

  const learnedQuery = QUERY_LEARNING.get(normalizedQuery);
  if (learnedQuery) {
    normalizedQuery = learnedQuery;
  }

  const incomingVariants = normalizeVariantList(
    extraVariants,
    normalizedQuery,
    "item"
  );

  const instantKey = scanFingerprint(normalizedQuery, incomingVariants);
  const instantHit = INSTANT_SCAN_CACHE.get(instantKey);

  if (Array.isArray(instantHit) && instantHit.length) {
    console.log("⚡ INSTANT SCAN CACHE HIT", {
      query: normalizedQuery,
      instantKey,
      count: instantHit.length,
    });
    return instantHit;
  }

  const runtimePlan = String(identity?.plan || "free").toLowerCase();

  const canUseEtsy =
    hasEtsyApi() &&
    !isSourceCoolingDown("etsy") &&
    (await sourceBudget.canUse("etsy", {
      plan: runtimePlan,
      costUnits: 2,
    }));

  const canUseEbay =
    hasEbayApi() &&
    !isSourceCoolingDown("ebay") &&
    (await sourceBudget.canUse("ebay", {
      plan: runtimePlan,
      costUnits: 1,
    }));

  const canUseWalmart =
    hasWalmartApi() &&
    !isSourceCoolingDown("walmart") &&
    (await sourceBudget.canUse("walmart", {
      plan: runtimePlan,
      costUnits: 1,
    }));

  const canUseBestBuy =
    hasBestBuyApi() &&
    !isSourceCoolingDown("bestbuy") &&
    (await sourceBudget.canUse("bestbuy", {
      plan: runtimePlan,
      costUnits: 1,
    }));

  const canUseSerpForce =
    !!SERPAPI_KEY &&
    !isSourceCoolingDown("serpapi") &&
    runtimePlan !== "free" &&
    (await sourceBudget.canUse("serpapi", {
      plan: runtimePlan,
      costUnits: 6,
    }));

  if (!canUseEbay && !canUseWalmart && !canUseBestBuy && !canUseEtsy && !canUseSerpForce) {
    console.warn("⚠️ No marketplace APIs configured — using backup web lanes only");
  }

  const inferredCategory = inferVisionCategory(normalizedQuery);
  const isEyewearQuery = inferredCategory === "eyewear";

  const lanes = buildRetrievalLanes(normalizedQuery, incomingVariants, identity);

  const googleQueries = [];
  const googleResults = [];
  const googleAll = [];

  let ebayAll = [];
  let walmartAll = [];
  let bestBuyAll = [];
  let backupAll = [];
  let etsyAll = [];
  let etsyVariants = [];

  const marketplaceQueries = uniqueQueries([
    normalizedQuery,
    ...incomingVariants,
    ...buildServerQueryVariants(normalizedQuery, incomingVariants, "item", identity),
    ...buildEmergencyShoppingFallbacks(normalizedQuery, incomingVariants),
  ]).slice(0, isEyewearQuery ? 10 : 12);

  if (marketplaceQueries.length) {
    const sourceResults = await Promise.all(
      marketplaceQueries.map((q) =>
        marketSearchConcurrency(async () => {
          const [ebayItems, walmartItems, bestBuyItems] = await Promise.all([
            canUseEbay
              ? runBudgetedSourceLane("ebay", () => ebayAdapterSearch(q), {
                  plan: runtimePlan,
                  costUnits: 1,
                })
              : Promise.resolve([]),
            canUseWalmart
              ? runBudgetedSourceLane("walmart", () => walmartCatalogSearch(q), {
                  plan: runtimePlan,
                  costUnits: 1,
                })
              : Promise.resolve([]),
            canUseBestBuy
              ? runBudgetedSourceLane("bestbuy", () => bestBuySearch(q), {
                  plan: runtimePlan,
                  costUnits: 1,
                })
              : Promise.resolve([]),
          ]);

          return {
            query: q,
            ebayItems,
            walmartItems,
            bestBuyItems,
          };
        })
      )
    );

    ebayAll = sourceResults.flatMap((x) => x?.ebayItems || []);
    walmartAll = sourceResults.flatMap((x) => x?.walmartItems || []);
    bestBuyAll = sourceResults.flatMap((x) => x?.bestBuyItems || []);
  }

  const backupLaneQueries = uniqueQueries([
    ...lanes.rescue,
    ...buildEmergencyShoppingFallbacks(normalizedQuery, incomingVariants),
  ]).slice(0, 6);

  if (backupLaneQueries.length) {
    const backupResults = await Promise.all(
      backupLaneQueries.map((q) =>
        marketSearchConcurrency(async () => {
          const bing = await bingBackupSearch(q);
          const googleCse = await googleCseBackupSearch(q);
          return {
            query: q,
            items: [...bing, ...googleCse],
          };
        })
      )
    );

    backupAll = backupResults.flatMap((x) => x?.items || []);
  }

  const shouldRunEtsyLane =
    canUseEtsy &&
    /glasses|eyewear|frames|sunglasses|bag|backpack|hat|cap|jacket|hoodie|shirt|shoe|sneaker/i.test(
      normalizedQuery
    );

  if (shouldRunEtsyLane) {
    etsyVariants = uniqueQueries(buildEtsyVariants(normalizedQuery)).slice(0, 3);

    const etsyResults = [];

    for (const q of etsyVariants) {
      if (Date.now() < ETSY_COOLDOWN_UNTIL || isSourceCoolingDown("etsy")) {
        break;
      }

      const result = await marketSearchConcurrency(async () => ({
        query: q,
        items: await runBudgetedSourceLane("etsy", () => etsySearch(q), {
          plan: runtimePlan,
          costUnits: 2,
        }),
      }));

      etsyResults.push(result);

      if (Array.isArray(result?.items) && result.items.length >= 8) {
        break;
      }
    }

    etsyAll = etsyResults.flatMap((x) => x.items || []);
  }

  const [retrievalSnapshot, retrievalIndexed] = await Promise.all([
    getRetrievalSnapshotCached(normalizedQuery).catch(() => null),
    searchRetrievalIndexCached(normalizedQuery, 24).catch(() => []),
  ]);

  const retrievalSeed = dedupeSmart([
    ...(Array.isArray(retrievalSnapshot?.items) ? retrievalSnapshot.items : []),
    ...(Array.isArray(retrievalIndexed) ? retrievalIndexed : []),
  ]).slice(0, 40);

let rawMerged = [
  ...ebayAll,
  ...walmartAll,
  ...bestBuyAll,
  ...backupAll,
  ...etsyAll,
  ...retrievalSeed,
];

/* ----- compute embeddings for visual vector search ----- */

let scanEmbedding = Array.isArray(identity?.embedding)
  ? identity.embedding
  : null;

if (!scanEmbedding && identity?.imageHash) {
  try {
    scanEmbedding = await loadStoredEmbedding(identity.imageHash);
  } catch (err) {
    console.warn("stored embedding load failed", err?.message || err);
  }
}

if (!scanEmbedding && identity?.imageBuffer) {
  try {
    scanEmbedding = identity?.imageHash
      ? await getOrCreateStoredEmbedding(identity.imageHash, identity.imageBuffer)
      : await computeImageEmbedding(identity.imageBuffer);
  } catch (err) {
    console.warn("embedding compute failed", err?.message || err);
  }
}

if (scanEmbedding && Array.isArray(rawMerged)) {
  rawMerged = rawMerged.map((item) => ({
    ...item,
    embedding: item.embedding || null,
    __vectorScore: item.embedding
      ? cosineSimilarity(scanEmbedding, item.embedding)
      : 0,
  }));
}

/* ------------------------------------------------------- */

/* ----- visual similarity boost before filtering ----- */

if (Array.isArray(rawMerged) && rawMerged.length > 0) {
  rawMerged = rawMerged
    .map(item => {
      const score = visualSimilarityScore(query, item?.title || "");

      return {
        ...item,
        __visualBoost: score
      };
    })
    .sort((a,b) => (b.__visualBoost || 0) - (a.__visualBoost || 0));
}

/* ---------------------------------------------------- */

  if (!rawMerged.length) {
    console.warn("🛟 Market rescue triggered");

    const rescueQueries = uniqueQueries([
      ...marketplaceQueries,
      `${normalizedQuery} used`,
      `${normalizedQuery} vintage`,
      `${normalizedQuery} orange lens`,
      `${normalizedQuery} black frame`,
      `${normalizedQuery} wrap sunglasses`,
      `${normalizedQuery} oval sunglasses`,
    ]).slice(0, 10);

    const rescueResults = await Promise.all(
      rescueQueries.map(async (q) => {
        const [ebayItems, walmartItems, bestBuyItems, etsyItems] =
          await Promise.all([
            ebayAdapterSearch(q).catch(() => []),
            canUseWalmart ? walmartCatalogSearch(q).catch(() => []) : Promise.resolve([]),
            canUseBestBuy ? bestBuySearch(q).catch(() => []) : Promise.resolve([]),
            canUseEtsy ? etsySearch(q).catch(() => []) : Promise.resolve([]),
          ]);

        return [...ebayItems, ...walmartItems, ...bestBuyItems, ...etsyItems];
      })
    );

    rawMerged = rescueResults.flat();
  }

  const stageWithTitle = rawMerged.filter((it) => it?.title);
  const stageWithPrice = stageWithTitle.filter(
    (it) => Number.isFinite(it?.totalPrice) || Number.isFinite(it?.price)
  );
  const stageNotBad = stageWithPrice.filter(
    (it) => !isBadListing(it.title, normalizedQuery)
  );
  const stageDeduped = dedupeSmart(stageNotBad);

  const preservedPool = stageDeduped
    .map((it) => ({
      ...it,
      __relevance:
        Number(it?.__relevance) || marketRelevanceScore(it, normalizedQuery),
    }))
    .sort((a, b) => Number(b.__relevance || 0) - Number(a.__relevance || 0));

  const stageRelevant = filterRelevantListings(normalizedQuery, stageDeduped);
  const stageMarketplacePreferred = preferMarketplaceIfHealthy(
    stageRelevant,
    normalizedQuery
  );
  const stageTiered = keepBestPriorityTier(
    stageMarketplacePreferred,
    normalizedQuery
  );
  const stageTrimmed = trimPriceOutliers(stageTiered);
  const stageIntuition = intuitionFilter(stageTrimmed);

  let ranked = stageIntuition;

  // Phase 2: image similarity rerank
ranked = ranked.map(item => ({
  ...item,
  __imageScore: imageSimilarityScore(identity, item)
}));

ranked.sort((a, b) => (b.__imageScore || 0) - (a.__imageScore || 0));

  if (ranked.length < 6 && preservedPool.length) {
    const rescue = preservedPool
      .filter((it) => Number(it.__relevance || 0) >= 0.24)
      .slice(0, 18);

    ranked = dedupeSmart([...ranked, ...rescue]);
  }

  ranked = sortByAbsoluteCheapest(ranked, normalizedQuery).slice(0, 60);

  if (ranked.length < 3 && stageTiered.length) {
    ranked = sortByAbsoluteCheapest(stageTiered, normalizedQuery).slice(0, 60);
  }

  if (ranked.length < 3 && stageRelevant.length) {
    ranked = sortByAbsoluteCheapest(stageRelevant, normalizedQuery).slice(0, 60);
  }

  if (ranked.length < 3 && preservedPool.length) {
    ranked = sortByAbsoluteCheapest(
      preservedPool.slice(0, 24),
      normalizedQuery
    ).slice(0, 60);
  }

  if (ranked.length < 3 && stageDeduped.length) {
    ranked = sortByAbsoluteCheapest(stageDeduped, normalizedQuery).slice(0, 60);
  }

  let merged = clusterListings(ranked).map((item) => ({
    ...item,
    __clusterScore: Number(item?.clusterScore || 0),
  }));

/* ----- moat resale intelligence ----- */

const soldStats = computeSoldCompStats(merged);
const sellThrough = estimateSellThrough(
  merged,
  merged.filter(i => i.sold)
);
const exitPrice = predictExitPrice(soldStats);

const demand = demandRadar(merged);

for (const item of merged) {
  item.marketDemand = demand;
  item.exitPriceEstimate = exitPrice;
}

/* ----------------------------------- */

const marketStats = priceDistribution(merged) || null;
const historicalStats =
  getHistoricalStats(normalizedQuery) ||
  productStats(normalizedQuery) ||
  null;
const heat = marketHeat(normalizedQuery);

// Phase FINAL: deal detection
for (const item of merged) {
  item.dealScore = detectDeal(item, marketStats || {});
}

// Phase 2: flip detection
for (const item of merged) {
  item.flipScore = flipOpportunity(item, marketStats || {});
}

// Phase 2: result clustering
const clusters = clusterListings(merged);

// Phase 2: background listing memory
rememberListings(normalizedQuery, merged);

for (const item of merged) {
  rememberProductNode(normalizedQuery, item);
}

// Phase FINAL: product memory graph
for (const item of merged) {
  rememberProduct(normalizedQuery, item);
}

// Phase 1: trust model
for (const item of merged) {
  item.trustModelScore = listingTrustScore(item);
}

// Phase 3: seller intelligence
for (const item of merged) {
  recordSeller(item);
}

// Phase FINAL: seller scoring
for (const item of merged) {
  item.sellerScore = finalSellerScore(item);
}

// Phase FINAL: visual authentication
for (const item of merged) {
  item.authRisk = counterfeitRiskScore(item, {
    marketAvg: marketStats?.avg ?? null,
    historicalAvg: historicalStats?.avg ?? null,
  });
}

// Phase 3: flip probability
for (const item of merged) {
  item.flipScore = Math.max(
    Number(item.flipScore || 0),
    Number(flipScore(item, {
      typicalHigh:
        historicalStats?.max ??
        marketStats?.max ??
        null,
    }) || 0)
  );
}

// Phase 2: scan confidence
const confidence = scanConfidence(identity, merged);

// FINAL ranking stabilization
merged = [...merged].sort((a, b) => {
  const aTrust = Number(a?.trustModelScore || 0);
  const bTrust = Number(b?.trustModelScore || 0);

  const aSeller = Number(a?.sellerScore || 0);
  const bSeller = Number(b?.sellerScore || 0);

  const aDeal = Number(a?.dealScore || 0);
  const bDeal = Number(b?.dealScore || 0);

  const aFlip = Number(a?.flipScore || 0);
  const bFlip = Number(b?.flipScore || 0);

  const aAuth = Number(a?.authRisk || 0);
  const bAuth = Number(b?.authRisk || 0);

  const aPrice =
    Number.isFinite(a?.totalPrice) ? Number(a.totalPrice) :
    Number.isFinite(a?.price) ? Number(a.price) :
    Infinity;

  const bPrice =
    Number.isFinite(b?.totalPrice) ? Number(b.totalPrice) :
    Number.isFinite(b?.price) ? Number(b.price) :
    Infinity;

  const aComposite =
    aTrust * 0.30 +
    aSeller * 0.16 +
    aDeal * 0.18 +
    aFlip * 0.16 -
    aAuth * 0.24;

  const bComposite =
    bTrust * 0.30 +
    bSeller * 0.16 +
    bDeal * 0.18 +
    bFlip * 0.16 -
    bAuth * 0.24;

  if (Math.abs(bComposite - aComposite) > 0.05) {
    return bComposite - aComposite;
  }

  if (aPrice !== bPrice) return aPrice - bPrice;

  return Number(b?.__relevance || 0) - Number(a?.__relevance || 0);
});

  if (!merged.length && canUseSerpForce && !isSourceCoolingDown("serpapi")) {
    const backupQueries = uniqueQueries([
      ...buildGoogleShoppingVariants(normalizedQuery, incomingVariants),
      ...buildEmergencyShoppingFallbacks(normalizedQuery, incomingVariants),
    ]).slice(0, isEyewearQuery ? 8 : 10);

    const backupResults = await Promise.all(
      backupQueries.map((q, idx) =>
        marketSearchConcurrency(() =>
          serpShopping(q, { softFail: idx > 0 })
        )
      )
    );

    const backup = backupResults.flat();

    const backupStageWithTitle = backup.filter((it) => it?.title);
    const backupStageWithPrice = backupStageWithTitle.filter(
      (it) => Number.isFinite(it?.totalPrice) || Number.isFinite(it?.price)
    );
    const backupStageNotBad = backupStageWithPrice.filter(
      (it) => !isBadListing(it.title, normalizedQuery)
    );
    const backupStageDeduped = dedupeSmart(backupStageNotBad);

    const fallbackPool = backupStageDeduped
      .map((it) => ({
        ...it,
        __relevance:
          Number(it?.__relevance) || marketRelevanceScore(it, normalizedQuery),
      }))
      .sort((a, b) => Number(b.__relevance || 0) - Number(a.__relevance || 0));

    let backupStageRelevant = filterRelevantListings(
      normalizedQuery,
      backupStageDeduped
    );

    if ((!backupStageRelevant || backupStageRelevant.length === 0) && backupStageDeduped.length) {
      backupStageRelevant = backupStageDeduped
        .map((it) => ({
          ...it,
          __relevance:
            Number(it?.__relevance) || marketRelevanceScore(it, normalizedQuery),
        }))
        .filter((it) => Number(it.__relevance || 0) >= 0.14)
        .sort((a, b) => Number(b.__relevance || 0) - Number(a.__relevance || 0))
        .slice(0, 60);
    }

    const backupStageMarketplacePreferred = preferMarketplaceIfHealthy(
      backupStageRelevant,
      normalizedQuery
    );
    const backupStageTiered = keepBestPriorityTier(
      backupStageMarketplacePreferred,
      normalizedQuery
    );
    const backupStageTrimmed = trimPriceOutliers(backupStageTiered);
    const backupStageIntuition = intuitionFilter(backupStageTrimmed);

    let fallbackRanked = backupStageIntuition;

    if (fallbackRanked.length < 6 && fallbackPool.length) {
      const rescue = fallbackPool
        .filter((it) => Number(it.__relevance || 0) >= 0.24)
        .slice(0, 18);

      fallbackRanked = dedupeSmart([...fallbackRanked, ...rescue]);
    }

    fallbackRanked = sortByAbsoluteCheapest(
      fallbackRanked,
      normalizedQuery
    ).slice(0, 60);

    if (fallbackRanked.length < 3 && backupStageTiered.length) {
      fallbackRanked = sortByAbsoluteCheapest(
        backupStageTiered,
        normalizedQuery
      ).slice(0, 60);
    }

    if (fallbackRanked.length < 3 && backupStageRelevant.length) {
      fallbackRanked = sortByAbsoluteCheapest(
        backupStageRelevant,
        normalizedQuery
      ).slice(0, 60);
    }

    if (fallbackRanked.length < 3 && fallbackPool.length) {
      fallbackRanked = sortByAbsoluteCheapest(
        fallbackPool.slice(0, 24),
        normalizedQuery
      ).slice(0, 60);
    }

    if (fallbackRanked.length < 3 && backupStageDeduped.length) {
      fallbackRanked = sortByAbsoluteCheapest(
        backupStageDeduped,
        normalizedQuery
      ).slice(0, 60);
    }

    merged = fallbackRanked;

    console.log("🛟 MARKET FALLBACK RECOVERY", {
      originalQuery: normalizedQuery,
      fallbackQueries: backupQueries,
      recovered: merged.length,
    });
  } else if (!merged.length && canUseSerpForce && isSourceCoolingDown("serpapi")) {
    console.warn("⚠️ Skipping market fallback recovery because SerpAPI is cooling down", {
      query: normalizedQuery,
    });
  }

  if (merged[0]?.source) {
    rememberSourceWin(normalizedQuery, merged[0].source);
  }

  const finalQuery = promoteQueryFromMarket(normalizedQuery, merged);

  if (Array.isArray(merged) && merged.length > 0) {
    scheduleRetrievalIngest(finalQuery || normalizedQuery, merged, identity);
  }

  if (Array.isArray(merged) && merged.length > 0) {
    scheduleIntelligenceLayerIngest(finalQuery || normalizedQuery, merged, identity);
  }

  if (Array.isArray(merged) && merged.length > 0) {
    INSTANT_SCAN_CACHE.set(instantKey, merged);
  }

  console.log("🔥 MARKET MERGED CHEAPEST", {
    query: normalizedQuery,
    finalQuery,
    googleQueries,
    incomingVariants,
    etsyVariants,
    google: googleAll.length,
    ebay: ebayAll.length,
    walmart: walmartAll.length,
    bestbuy: bestBuyAll.length,
    etsy: etsyAll.length,
    merged: merged.length,
    cheapestTotal: merged[0]?.totalPrice ?? merged[0]?.price ?? null,
    cheapestTitle: merged[0]?.title ?? null,
    cheapestSource: merged[0]?.source ?? null,
    instantKey,
    etsyCooling: isSourceCoolingDown("etsy"),
  });

  merged = attachMarketTruthScores(merged, normalizedQuery, identity)
    .sort((a, b) => {
      const trustDiff = Number(b.__trustScore || 0) - Number(a.__trustScore || 0);
      if (Math.abs(trustDiff) > 0.06) return trustDiff;

      const clusterDiff = Number(b.__clusterScore || 0) - Number(a.__clusterScore || 0);
      if (Math.abs(clusterDiff) > 0.06) return clusterDiff;

      const priceA = finitePrice(a?.totalPrice ?? a?.price);
      const priceB = finitePrice(b?.totalPrice ?? b?.price);

      return Number(priceA || Infinity) - Number(priceB || Infinity);
    })
    .slice(0, 60);

// Phase 2: product memory graph
for (const item of merged.slice(0, 10)) {
  rememberFinalProduct(normalizedQuery, item);
}

enrichProduct(normalizedQuery, merged);

return merged;

})();

return Promise.race([worker, killTimer]).then((r) => {
  if (r === "__timeout__") {
    console.warn("⚡ MARKET SEARCH TIMEOUT (4s)");
    return [];
  }
  return r;
});
}

function attachMarketTruthScores(items, query, identity) {

  if (!Array.isArray(items)) return [];

  return items.map((item) => {

    let trust = 0.5;
    let cluster = 0.5;

    const title = (item.title || "").toLowerCase();
    const q = (query || "").toLowerCase();

    // query similarity
    if (title.includes(q)) {
      cluster += 0.25;
    }

    // brand match
    if (identity?.brand && title.includes(identity.brand.toLowerCase())) {
      cluster += 0.2;
    }

    // seller rating
    if (item.rating && item.rating > 4.5) {
      trust += 0.2;
    }

    // review count
    if (item.reviews && item.reviews > 20) {
      trust += 0.1;
    }

    // verified link
    if (item.linkVerified) {
      trust += 0.1;
    }

    // suspicious price check
    const price = item.totalPrice ?? item.price;

    if (price && price < 5) {
      trust -= 0.2;
    }

    return {
      ...item,
      __trustScore: Math.max(0, Math.min(trust, 1)),
      __clusterScore: Math.max(0, Math.min(cluster, 1))
    };
  });
}

// Stronger dedupe: titleKey + rounded total
function dedupeSmart(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const titleKey = normalizeTitleKey(it?.title || "");
    const total = it?.totalPrice ?? it?.price;
    const bucket = typeof total === "number" ? Math.round(total * 2) / 2 : "na";
    const key = `${titleKey}|${bucket}|${String(it?.source || "")}`;

    if (!titleKey) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// -------------------- INTELLIGENCE HELPERS --------------------
function isBadListing(title = "", query = "") {
  const t = String(title || "").toLowerCase();
  const q = String(query || "").toLowerCase();

  const badWords = [
    "for parts",
    "parts only",
    "not working",
    "broken",
    "repair",
    "refurbished",
    "lot",
    "bundle",
    "pack",
    "set of",
    "x2",
    "x3",
    "x4",
    "auction",
    "bid",
    "read description",
    "as is",
  ];

  if (badWords.some((w) => t.includes(w))) return true;

  const queryIsEyewear =
    q.includes("glasses") ||
    q.includes("eyewear") ||
    q.includes("frames") ||
    q.includes("lens") ||
    q.includes("sunglasses");

  const queryWantsBlue =
    q.includes("blue light") ||
    q.includes("blue-light") ||
    q.includes("computer") ||
    q.includes("gaming") ||
    q.includes("block blue") ||
    q.includes("blue blocker") ||
    q.includes("blue blocking") ||
    q.includes("screen");

  const queryWantsOrange =
    q.includes("orange") ||
    q.includes("amber") ||
    q.includes("yellow");

  const queryWantsSun =
    q.includes("sunglass") ||
    q.includes("shade") ||
    q.includes("shades") ||
    q.includes("uv") ||
    q.includes("uv400") ||
    q.includes("polarized");

  const queryWantsWrap =
    q.includes("wrap") ||
    q.includes("shield");

  const fashionOrangeWrap =
    queryIsEyewear &&
    queryWantsOrange &&
    queryWantsWrap &&
    queryWantsSun &&
    !queryWantsBlue;

  const allowBlueFallback =
    queryIsEyewear &&
    queryWantsOrange &&
    queryWantsWrap &&
    !queryWantsSun &&
    !queryWantsBlue;

  const titleLooksBlue =
    t.includes("blue light") ||
    t.includes("blue-light") ||
    t.includes("computer") ||
    t.includes("gaming") ||
    t.includes("block blue") ||
    t.includes("blue blocker") ||
    t.includes("blue blocking") ||
    t.includes("screen") ||
    t.includes("blokz");

  const titleLooksSun =
    t.includes("sunglass") ||
    t.includes("shade") ||
    t.includes("shades") ||
    t.includes("uv") ||
    t.includes("uv400") ||
    t.includes("polarized");

  const hardRejectWords = [
    "forensic",
    "forensics",
    "laser",
    "wavelength",
    "nm",
    "shooting glasses",
    "ballistic",
    "lab glasses",
    "industrial glasses",
    "protective glasses",
    "safety glasses",
    "goggles",
    "phototherapy",
    "therapy glasses",
    "filter glasses",
    "inspection glasses",
    "exam glasses",
  ];

  if (hardRejectWords.some((w) => t.includes(w))) return true;

  // if query clearly wants sunglasses, aggressively reject blue-light/computer junk
  if (queryWantsSun && titleLooksBlue && !titleLooksSun && !allowBlueFallback) {
    return true;
  }

  // keep this safeguard, but do NOT auto-reject sporty wraparound sunglasses
  if (fashionOrangeWrap && titleLooksBlue && !titleLooksSun) {
    return true;
  }

  return false;
}

function trimPriceOutliers(items) {
  const bounded = (Array.isArray(items) ? items : []).filter((it) => {
    const p = Number(it?.totalPrice ?? it?.price);
    return Number.isFinite(p) && p > 3 && p < 5000;
  });

  const prices = bounded
    .map((i) => i?.totalPrice ?? i?.price)
    .filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  if (prices.length < 4) return bounded;

  const q1 = quantile(prices, 0.25);
  const q3 = quantile(prices, 0.75);
  const iqr = Math.max((q3 ?? 0) - (q1 ?? 0), 0.01);

  const lowFence = Math.max(0, (q1 ?? 0) - 1.5 * iqr);
  const highFence = (q3 ?? 0) + 1.5 * iqr;

  const filtered = bounded.filter((i) => {
    const p = i?.totalPrice ?? i?.price;
    return (
      typeof p === "number" &&
      Number.isFinite(p) &&
      p >= lowFence &&
      p <= highFence
    );
  });

  return filtered.length >= Math.min(4, bounded.length) ? filtered : bounded;
}

// 🧠 HUMAN INTUITION FILTER
function intuitionFilter(items) {
  const prices = items
    .map((i) => i?.totalPrice ?? i?.price)
    .filter((n) => typeof n === "number" && n > 0)
    .sort((a, b) => a - b);

  if (prices.length < 5) return items;

  const med = median(prices);
  const lowCut = med * 0.35;

  const filtered = items.filter((it) => {
    const p = it?.totalPrice ?? it?.price;
    if (!p) return false;
    if (p < lowCut) return false;
    return true;
  });

  return filtered.length >= Math.min(4, items.length) ? filtered : items;
}

function resaleProbability(items) {
  if (!items.length) return 0;
  const prices = items.map(i => i.price).filter(Boolean);
  if (!prices.length) return 0;

  const spread = Math.max(...prices) - Math.min(...prices);
  const avg = prices.reduce((a,b)=>a+b,0)/prices.length;

  return clamp01(spread / avg);
}

// 🧠 MARKET CONFIDENCE SCORE
function marketConfidence(items) {
  if (!items?.length) return 0;

  const prices = items
    .map(i => i?.totalPrice ?? i?.price)
    .filter(n => typeof n === "number" && n > 0);

  if (prices.length < 3) return 0.25;

  const spread = Math.max(...prices) - Math.min(...prices);
  const avg = prices.reduce((a,b)=>a+b,0)/prices.length;

  // tighter spread = stronger confidence
  const stability = 1 - clamp01(spread / Math.max(avg,1));

  return clamp01(stability);
}

function buildMarketConsensus(items, payingPrice = null, visionConfidence = 0.5) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const intuition = computeMarketIntuition(list, payingPrice);

  const priced = list
    .map((i) => i?.totalPrice ?? i?.price)
    .filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0);

  const avgPrice = priced.length
    ? finitePrice(priced.reduce((a, b) => a + b, 0) / priced.length)
    : null;

  const sources = new Set(
    list
      .map((i) => String(i?.source || "").toLowerCase())
      .filter(Boolean)
  );

  const listingCount = list.length;
  const sourceDiversity = sources.size;
  const confidence = marketConfidence(list);

  const consensusScore = clamp01(
    confidence * 0.55 +
      Math.min(listingCount / 12, 1) * 0.25 +
      Math.min(sourceDiversity / 4, 1) * 0.20
  );

  const thinMarket = listingCount < 5 || sourceDiversity < 2;
  const suspiciousMarket =
    intuition?.isWeirdPrice === true ||
    confidence < 0.24 ||
    listingCount < 3;

  return {
    median: intuition?.median ?? null,
    avgPrice,
    typicalLow: intuition?.typicalLow ?? null,
    typicalHigh: intuition?.typicalHigh ?? null,
    listingCount,
    sourceDiversity,
    marketConfidence: confidence,
    consensusScore,
    thinMarket,
    suspiciousMarket,
    payingPrice: finitePrice(payingPrice),
    deal: buildLocalDealVerdict(intuition, visionConfidence),
  };
}


function trustScore(it) {
  const rating = it.rating || 0;
  const reviews = it.reviews || 0;

  const ratingScore = rating / 5;
  const reviewScore = Math.min(reviews / 500, 1);

  return (ratingScore * 0.6) + (reviewScore * 0.4);
}

function hashString(s = "") {
  return sha256(Buffer.from(s)).slice(0, 8);
}

const INTERNAL_MARKET_SNAPSHOT_FRESH_MS = Math.max(
  60_000,
  Number(process.env.INTERNAL_MARKET_SNAPSHOT_FRESH_MS || 15 * 60 * 1000)
);

const INTERNAL_MARKET_SNAPSHOT_STALE_MS = Math.max(
  INTERNAL_MARKET_SNAPSHOT_FRESH_MS + 60_000,
  Number(process.env.INTERNAL_MARKET_SNAPSHOT_STALE_MS || 6 * 60 * 60 * 1000)
);

const INTERNAL_MARKET_REFRESH_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.INTERNAL_MARKET_REFRESH_INTERVAL_MS || 3 * 60 * 1000)
);

const INTERNAL_MARKET_SNAPSHOT_L1 = new TTLCache({
  ttlMs: Math.max(
    60_000,
    Number(
      process.env.INTERNAL_MARKET_SNAPSHOT_L1_TTL_MS ||
        Math.min(INTERNAL_MARKET_SNAPSHOT_FRESH_MS, 10 * 60 * 1000)
    )
  ),
  maxSize: Math.max(
    200,
    Number(process.env.INTERNAL_MARKET_SNAPSHOT_L1_MAX || 1200)
  ),
});

let INTERNAL_MARKET_REFRESH_LOOP_STARTED = false;

function internalMarketSnapshotRedisKey(query = "") {
  return `internal_market_snapshot:${canonicalMarketQuery(query)}`;
}

function internalMarketSnapshotDiskKey(query = "") {
  return `internal-market/snapshots/${hashString(
    canonicalMarketQuery(query) || "empty"
  )}.json`;
}

function sanitizeVisionIdentityForSnapshot(identity = null) {
  if (!identity || typeof identity !== "object") return null;

  const cleaned = {
    ...identity,
  };

  delete cleaned.imageBuffer;
  delete cleaned.embedding;

  return cleaned;
}

function compactMarketSnapshotItem(it = {}) {
  const price = finitePrice(it?.totalPrice ?? it?.price);

  return {
    title: it?.title || null,
    source: it?.source || null,
    price,
    totalPrice: price,
    url: it?.url || it?.buyLink || it?.link || null,
    link: it?.link || it?.url || it?.buyLink || null,
    buyLink: it?.buyLink || it?.url || it?.link || null,
    image: it?.image || null,
    rating: typeof it?.rating === "number" ? it.rating : null,
    reviews: typeof it?.reviews === "number" ? it.reviews : null,
    dealScore: Number(it?.dealScore || 0),
    flipScore: Number(it?.flipScore || 0),
    sellerScore: Number(it?.sellerScore || 0),
    trust:
      Number(
        it?.trust ??
          it?.trustModelScore ??
          it?.__trustScore ??
          0
      ) || 0,
    authRisk: Number(it?.authRisk || 0),
    visualScore:
      Number(
        it?.visualScore ??
          it?.__imageScore ??
          it?.__visualBoost ??
          0
      ) || 0,
    linkVerified: it?.linkVerified !== false,
    sold: it?.sold === true,
    status: it?.status || null,
  };
}

function hydrateMarketSnapshotItem(it = {}) {
  const price = finitePrice(it?.totalPrice ?? it?.price);

  return {
    title: it?.title || null,
    source: it?.source || null,
    price,
    totalPrice: price,
    url: it?.url || it?.link || it?.buyLink || null,
    link: it?.link || it?.url || it?.buyLink || null,
    buyLink: it?.buyLink || it?.url || it?.link || null,
    image: it?.image || null,
    rating: typeof it?.rating === "number" ? it.rating : null,
    reviews: typeof it?.reviews === "number" ? it.reviews : null,
    dealScore: Number(it?.dealScore || 0),
    flipScore: Number(it?.flipScore || 0),
    sellerScore: Number(it?.sellerScore || 0),
    trustModelScore:
      Number(it?.trust ?? it?.trustModelScore ?? it?.__trustScore ?? 0) || 0,
    __trustScore:
      Number(it?.trust ?? it?.trustModelScore ?? it?.__trustScore ?? 0) || 0,
    authRisk: Number(it?.authRisk || 0),
    visualScore: Number(it?.visualScore || 0),
    linkVerified: it?.linkVerified !== false,
    sold: it?.sold === true,
    status: it?.status || null,
  };
}

function getInternalSnapshotState(snapshot = null) {
  const refreshedAt = Number(
    snapshot?.refreshedAt || snapshot?.createdAt || 0
  );

  const ageMs = refreshedAt ? Math.max(0, Date.now() - refreshedAt) : Infinity;

  return {
    refreshedAt: refreshedAt || null,
    ageMs,
    isFresh: ageMs <= INTERNAL_MARKET_SNAPSHOT_FRESH_MS,
    isServeable: ageMs <= INTERNAL_MARKET_SNAPSHOT_STALE_MS,
  };
}

async function saveInternalMarketSnapshot(query, payload = {}) {
  const q = normalizeQuery(query);
  if (!q) return null;

  const doc = {
    query: q,
    canonicalQuery: canonicalMarketQuery(q),
    source: payload?.source || "live_market",
    createdAt: Number(payload?.createdAt || Date.now()),
    refreshedAt: Date.now(),
    searchedQueries: uniqueQueries(payload?.searchedQueries || []).slice(0, 20),
    variants: uniqueQueries(payload?.variants || []).slice(0, 12),
    items: (Array.isArray(payload?.items) ? payload.items : [])
      .map(compactMarketSnapshotItem)
      .filter((x) => x?.title)
      .slice(0, 24),
    best: payload?.best ? compactMarketSnapshotItem(payload.best) : null,
    consensus: payload?.consensus || null,
    prediction: payload?.prediction || null,
    coach: payload?.coach || null,
    pulse: payload?.pulse || null,
    historical: payload?.historical || null,
    intelligence: payload?.intelligence || null,
    marketHeat:
      typeof payload?.marketHeat === "number" ? payload.marketHeat : null,
    visionIdentity: sanitizeVisionIdentityForSnapshot(
      payload?.visionIdentity || null
    ),
  };

  INTERNAL_MARKET_SNAPSHOT_L1.set(q, doc);

  try {
    await cacheSet(
      internalMarketSnapshotRedisKey(q),
      doc,
      Math.ceil(INTERNAL_MARKET_SNAPSHOT_STALE_MS / 1000)
    );
  } catch {}

  try {
    await writeJson(internalMarketSnapshotDiskKey(q), doc);
  } catch (err) {
    console.warn("⚠️ internal market snapshot disk save failed", err?.message || err);
  }

  return doc;
}

async function readInternalMarketSnapshot(query = "") {
  const q = normalizeQuery(query);
  if (!q) return null;

  const l1 = INTERNAL_MARKET_SNAPSHOT_L1.get(q);
  if (l1) return l1;

  try {
    const l2 = await cacheGet(internalMarketSnapshotRedisKey(q));
    if (l2?.items?.length) {
      INTERNAL_MARKET_SNAPSHOT_L1.set(q, l2);
      return l2;
    }
  } catch {}

  const disk = await readJson(internalMarketSnapshotDiskKey(q));
  if (disk?.items?.length) {
    INTERNAL_MARKET_SNAPSHOT_L1.set(q, disk);

    try {
      await cacheSet(
        internalMarketSnapshotRedisKey(q),
        disk,
        Math.ceil(INTERNAL_MARKET_SNAPSHOT_STALE_MS / 1000)
      );
    } catch {}

    return disk;
  }

  return null;
}

function marketSnapshotItemsFromPrecompute(snapshot = null) {
  if (!snapshot || typeof snapshot !== "object") return [];

  const out = [];

  if (snapshot?.best && typeof snapshot.best === "object") {
    out.push(hydrateMarketSnapshotItem(snapshot.best));
  }

  if (Array.isArray(snapshot?.top)) {
    out.push(...snapshot.top.map(hydrateMarketSnapshotItem));
  }

  return out.filter((x) => x?.title);
}

async function buildInternalRetrievalSeed(query, identity = null) {
  const q = normalizeQuery(query);
  if (!q) {
    return {
      items: [],
      source: "miss",
      counts: {
        precompute: 0,
        retrievalSnapshot: 0,
        retrievalIndex: 0,
      },
    };
  }

  const preferred = chooseBestIdentityQuery(identity, q);

  const candidateQueries = uniqueQueries([
    q,
    preferred,
    canonicalMarketQuery(q),
  ]).slice(0, 3);

  let precomputeCount = 0;
  let retrievalSnapshotCount = 0;
  let retrievalIndexCount = 0;

  let merged = [];

  for (const candidate of candidateQueries) {
    const [precompute, retrievalSnapshot, retrievalHits] = await Promise.all([
      getPrecomputeSnapshot(candidate).catch(() => null),
      getRetrievalSnapshotCached(candidate).catch(() => null),
      searchRetrievalIndexCached(candidate, 24).catch(() => []),
    ]);

    const precomputeItems = marketSnapshotItemsFromPrecompute(precompute);
    const snapshotItems = Array.isArray(retrievalSnapshot?.items)
      ? retrievalSnapshot.items
      : [];
    const hitItems = Array.isArray(retrievalHits) ? retrievalHits : [];

    precomputeCount += precomputeItems.length;
    retrievalSnapshotCount += snapshotItems.length;
    retrievalIndexCount += hitItems.length;

    merged.push(...precomputeItems);
    merged.push(...snapshotItems);
    merged.push(...hitItems);
  }

  merged = dedupeSmart(merged.filter((x) => x?.title));
  merged = filterRelevantListings(q, merged);
  merged = trimPriceOutliers(merged);
  merged = sortByAbsoluteCheapest(merged, q, identity).slice(0, 24);

  const source =
    precomputeCount > 0
      ? "precompute_snapshot"
      : retrievalSnapshotCount > 0
      ? "retrieval_snapshot"
      : retrievalIndexCount > 0
      ? "retrieval_index"
      : "miss";

  return {
    items: merged,
    source,
    counts: {
      precompute: precomputeCount,
      retrievalSnapshot: retrievalSnapshotCount,
      retrievalIndex: retrievalIndexCount,
    },
  };
}

function scheduleInternalMarketRefresh(query = "", identity = null, reason = "phase4_refresh") {
  const q = normalizeQuery(query);
  if (!q) return null;

  return enqueueBackgroundJob(
    "phase4_internal_market_refresh",
    {
      query: q,
      reason,
      visionIdentity: sanitizeVisionIdentityForSnapshot(identity || null),
    },
    async (payload) => {
      const liveItems = await mergeCheapestSources(
        payload.query,
        [],
        payload.visionIdentity || null
      );

      if (Array.isArray(liveItems) && liveItems.length > 0) {
        await saveInternalMarketSnapshot(payload.query, {
          source: "background_refresh",
          searchedQueries: [payload.query],
          variants: [],
          items: liveItems,
          best: liveItems[0] || null,
          visionIdentity: payload.visionIdentity || null,
        });
      }

      return {
        ok: true,
        query: payload.query,
        count: Array.isArray(liveItems) ? liveItems.length : 0,
        reason: payload.reason,
      };
    }
  );
}

async function resolveInternalMarketHit(query, identity = null, { allowStale = true } = {}) {
  const q = normalizeQuery(query);
  if (!q) {
    return {
      hit: false,
      source: "miss",
      kind: "miss",
      items: [],
      snapshot: null,
      snapshotState: getInternalSnapshotState(null),
    };
  }

  const storedSnapshot = await readInternalMarketSnapshot(q);
  const snapshotState = getInternalSnapshotState(storedSnapshot);

  const storedItems = Array.isArray(storedSnapshot?.items)
    ? storedSnapshot.items.map(hydrateMarketSnapshotItem).filter((x) => x?.title)
    : [];

  if (storedItems.length >= 4 && snapshotState.isFresh) {
    return {
      hit: true,
      source: "market_snapshot",
      kind: "fresh_snapshot",
      items: storedItems,
      snapshot: storedSnapshot,
      snapshotState,
    };
  }

  if (storedItems.length >= 4 && allowStale && snapshotState.isServeable) {
    scheduleInternalMarketRefresh(q, identity, "stale_snapshot");

    return {
      hit: true,
      source: "market_snapshot",
      kind: "stale_snapshot",
      items: storedItems,
      snapshot: storedSnapshot,
      snapshotState,
    };
  }

  const seed = await buildInternalRetrievalSeed(q, identity);

  if (seed.items.length >= 6) {
    return {
      hit: true,
      source: seed.source,
      kind: "internal_seed",
      items: seed.items,
      snapshot: storedSnapshot,
      snapshotState,
      counts: seed.counts,
    };
  }

  return {
    hit: false,
    source: "miss",
    kind: "miss",
    items: [],
    snapshot: storedSnapshot,
    snapshotState,
    counts: seed.counts,
  };
}

function startInternalMarketRefreshLoop() {
  if (INTERNAL_MARKET_REFRESH_LOOP_STARTED) return;
  INTERNAL_MARKET_REFRESH_LOOP_STARTED = true;

  const timer = setInterval(async () => {
    try {
      const crawlerCandidates = getCrawlerQueueCandidates(6)
        .map((x) => normalizeQuery(x?.query || ""))
        .filter(Boolean);

      const pulseCandidates = getTopPulse(6)
        .map((x) => normalizeQuery(x?.query || ""))
        .filter(Boolean);

      const candidates = uniqueQueries([
        ...crawlerCandidates,
        ...pulseCandidates,
      ]).slice(0, 8);

      for (const q of candidates) {
        const snapshot = await readInternalMarketSnapshot(q);
        const state = getInternalSnapshotState(snapshot);

        if (!snapshot?.items?.length || !state.isFresh) {
          scheduleInternalMarketRefresh(q, null, "phase4_loop");
        }
      }
    } catch (err) {
      console.warn("phase4 internal refresh loop failed", err?.message || err);
    }
  }, INTERNAL_MARKET_REFRESH_INTERVAL_MS);

  timer.unref?.();
}

// 🧠 MARKET INTELLIGENCE MEMORY
const SOURCE_MEMORY = new Map();
const SOURCE_HEALTH = new Map();

function pruneLongLivedMaps() {
  const trimOldest = (map, maxSize) => {
    while (map.size > maxSize) {
      const firstKey = map.keys().next().value;
      if (!firstKey) break;
      map.delete(firstKey);
    }
  };

  trimOldest(QUERY_LEARNING, 5000);
  trimOldest(QUERY_PULSE, 5000);
  trimOldest(SOURCE_MEMORY, 5000);
  trimOldest(SOURCE_HEALTH, 256);
}

setInterval(() => {
  pruneLongLivedMaps();
}, 5 * 60 * 1000).unref?.();

function defaultSourceHealth() {
  return {
    successes: 0,
    failures: 0,
    timeouts: 0,
    cooldownUntil: 0,
    lastLatencyMs: null,
    lastError: null,
    updatedAt: 0,
  };
}

function syncSourceMemoryFromRedis(query) {
  const key = normalizeQuery(query);
  if (!key) return;

  scheduleRedisStateRefresh(sourceMemoryCacheKey(key), (remote) => {
    if (!remote || typeof remote !== "object") return;

    SOURCE_MEMORY.set(key, {
      ...(SOURCE_MEMORY.get(key) || {}),
      ...remote,
    });
  });
}

function syncSourceHealthFromRedis(source) {
  const key = String(source || "unknown").toLowerCase();

  scheduleRedisStateRefresh(sourceHealthCacheKey(key), (remote) => {
    if (!remote || typeof remote !== "object") return;

    SOURCE_HEALTH.set(key, {
      ...defaultSourceHealth(),
      ...(SOURCE_HEALTH.get(key) || {}),
      ...remote,
    });
  });
}

function rememberSourceWin(query, source) {
  if (!query || !source) return;

  const key = normalizeQuery(query);
  const src = String(source).toLowerCase();

  syncSourceMemoryFromRedis(key);

  const current = SOURCE_MEMORY.get(key) || {};
  const next = {
    ...current,
    [src]: Number(current[src] || 0) + 1,
  };

  SOURCE_MEMORY.set(key, next);
  mirrorStateWrite(sourceMemoryCacheKey(key), next, STATE_MIRROR_TTL_SEC);
}

function getSourceHealth(source) {
  const key = String(source || "unknown").toLowerCase();

  if (!SOURCE_HEALTH.has(key)) {
    SOURCE_HEALTH.set(key, defaultSourceHealth());
  }

  syncSourceHealthFromRedis(key);
  return SOURCE_HEALTH.get(key);
}

function markSourceSuccess(source, latencyMs = 0) {
  const key = String(source || "unknown").toLowerCase();
  const h = {
    ...defaultSourceHealth(),
    ...getSourceHealth(key),
  };

  h.successes += 1;
  h.failures = Math.max(0, h.failures - 1);
  h.timeouts = Math.max(0, h.timeouts - 1);
  h.lastLatencyMs = Number.isFinite(latencyMs) ? latencyMs : null;
  h.lastError = null;
  h.updatedAt = Date.now();
  h.cooldownUntil = 0;

  SOURCE_HEALTH.set(key, h);
  mirrorStateWrite(sourceHealthCacheKey(key), h, STATE_MIRROR_TTL_SEC);

  incMetric("source_success_total", 1, { source: key });
  setMetric("source_cooling", 0, { source: key });
}

function markSourceFailure(source, reason = "error") {
  const key = String(source || "unknown").toLowerCase();
  const h = {
    ...defaultSourceHealth(),
    ...getSourceHealth(key),
  };

  h.failures += 1;
  if (reason === "timeout") h.timeouts += 1;

  h.lastError = String(reason || "error");
  h.updatedAt = Date.now();

  const strike = h.failures + h.timeouts * 2;
  if (strike >= 3) {
    const cooldownMs = Math.min(180000, 30000 * strike);
    h.cooldownUntil = Date.now() + cooldownMs;

    pushOpsAlert(
      "source_cooldown_triggered",
      {
        source: key,
        reason: h.lastError,
        failures: h.failures,
        timeouts: h.timeouts,
        cooldownMs,
      },
      60_000
    );
  }

  SOURCE_HEALTH.set(key, h);
  mirrorStateWrite(sourceHealthCacheKey(key), h, STATE_MIRROR_TTL_SEC);

  incMetric("source_failure_total", 1, {
    source: key,
    reason: h.lastError,
  });
}

function isSourceCoolingDown(source) {
  const key = String(source || "unknown").toLowerCase();
  const h = getSourceHealth(key);
  const cooling = (h.cooldownUntil || 0) > Date.now();

  setMetric("source_cooling", cooling ? 1 : 0, { source: key });
  return cooling;
}

function sourceInfraWeight(source) {
  const key = String(source || "unknown").toLowerCase();
  const h = getSourceHealth(key);

  if (isSourceCoolingDown(key)) return 0.15;

  let score = 1;

  if (h.lastLatencyMs && h.lastLatencyMs > 5000) score -= 0.18;
  if (h.failures > 0) score -= Math.min(h.failures * 0.07, 0.28);
  if (h.timeouts > 0) score -= Math.min(h.timeouts * 0.12, 0.36);

  return Math.max(0.35, score);
}

function sourceWeight(src = "", query = "") {
  const s = String(src || "").toLowerCase();
  const q = normalizeQuery(query);

  syncSourceMemoryFromRedis(q);

  let base = marketplaceSourceScore(s);

  const memory = SOURCE_MEMORY.get(q);
  if (memory && memory[s]) {
    base += Math.min(memory[s] * 0.03, 0.15);
  }

  return base * sourceInfraWeight(s);
}

const ebayTokenState = {
  accessToken: null,
  expiresAt: 0,
  inflight: null,
};

const walmartTokenState = {
  accessToken: null,
  expiresAt: 0,
  inflight: null,
};

function hasEbayApi() {
  return !!(EBAY_CLIENT_ID && EBAY_CLIENT_SECRET);
}

function hasWalmartApi() {
  return !!(WALMART_CLIENT_ID && WALMART_CLIENT_SECRET);
}

function hasBestBuyApi() {
  return !!BESTBUY_API_KEY;
}

function hasEtsyApi() {
  return !!(ETSY_API_KEY && ETSY_SHARED_SECRET && ETSY_OAUTH_TOKEN);
}

function hasAnyMarketSource() {
  return hasEbayApi() || hasWalmartApi() || hasBestBuyApi() || hasEtsyApi();
}

function buildEtsyApiKeyHeader() {
  return ETSY_SHARED_SECRET
    ? `${ETSY_API_KEY}:${ETSY_SHARED_SECRET}`
    : ETSY_API_KEY;
}

function newCorrelationId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
}

async function getEbayAccessToken() {
  if (!hasEbayApi()) return null;

  if (
    ebayTokenState.accessToken &&
    ebayTokenState.expiresAt > Date.now() + 30 * 1000
  ) {
    return ebayTokenState.accessToken;
  }

  if (ebayTokenState.inflight) {
    return ebayTokenState.inflight;
  }

  ebayTokenState.inflight = (async () => {
    try {
      const startedAt = Date.now();
      const basic = Buffer.from(
        `${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`
      ).toString("base64");

      const body = new URLSearchParams({
        grant_type: "client_credentials",
        scope:
          "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/buy.item.bulk",
      });

      const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });

      if (!r.ok) {
        markSourceFailure("ebay_api_auth", `http_${r.status}`);
        console.warn("⚠️ eBay token request failed:", r.status);
        return null;
      }

      const data = await r.json().catch(() => ({}));
      const token =
        typeof data?.access_token === "string" ? data.access_token : null;
      const expiresIn = Number(data?.expires_in || 7200);

      if (!token) {
        markSourceFailure("ebay_api_auth", "missing_token");
        return null;
      }

      ebayTokenState.accessToken = token;
      ebayTokenState.expiresAt =
        Date.now() + Math.max(5 * 60 * 1000, (expiresIn - 60) * 1000);

      markSourceSuccess("ebay_api_auth", Date.now() - startedAt);
      return token;
    } catch (err) {
      markSourceFailure(
        "ebay_api_auth",
        err?.name === "AbortError" ? "timeout" : "exception"
      );
      console.warn("⚠️ eBay token error:", err?.message || err);
      return null;
    }
  })().finally(() => {
    ebayTokenState.inflight = null;
  });

  return ebayTokenState.inflight;
}

async function getWalmartAccessToken() {
  if (!hasWalmartApi()) return null;

  if (
    walmartTokenState.accessToken &&
    walmartTokenState.expiresAt > Date.now() + 30 * 1000
  ) {
    return walmartTokenState.accessToken;
  }

  if (walmartTokenState.inflight) {
    return walmartTokenState.inflight;
  }

  walmartTokenState.inflight = (async () => {
    try {
      const startedAt = Date.now();
      const basic = Buffer.from(
        `${WALMART_CLIENT_ID}:${WALMART_CLIENT_SECRET}`
      ).toString("base64");

      const r = await fetch("https://marketplace.walmartapis.com/v3/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });

      if (!r.ok) {
        markSourceFailure("walmart_auth", `http_${r.status}`);
        console.warn("⚠️ Walmart token request failed:", r.status);
        return null;
      }

      const data = await r.json().catch(() => ({}));
      const token =
        typeof data?.access_token === "string" ? data.access_token : null;
      const expiresIn = Number(data?.expires_in || 900);

      if (!token) {
        markSourceFailure("walmart_auth", "missing_token");
        return null;
      }

      walmartTokenState.accessToken = token;
      walmartTokenState.expiresAt =
        Date.now() + Math.max(2 * 60 * 1000, (expiresIn - 60) * 1000);

      markSourceSuccess("walmart_auth", Date.now() - startedAt);
      return token;
    } catch (err) {
      markSourceFailure(
        "walmart_auth",
        err?.name === "AbortError" ? "timeout" : "exception"
      );
      console.warn("⚠️ Walmart token error:", err?.message || err);
      return null;
    }
  })().finally(() => {
    walmartTokenState.inflight = null;
  });

  return walmartTokenState.inflight;
}

function smartRank(items, query = "", identity = null) {
  return items
    .map((it) => {
      const total = it.totalPrice ?? it.price;
      const priceScore = 1 / Math.max(total || 1, 1);

      const identityScore = identity
        ? listingIdentityScore(it, identity)
        : 0;

      const relevance =
        marketRelevanceScore(it, query) * 0.7 +
        identityScore * 0.3;

      const trust = trustScore(it);
      const marketBias = marketplaceSourceScore(it.source);

      const tie =
        (parseInt(hashString(it.link || it.title || "0"), 16) % 1000) / 1000;

      it.__rank =
        priceScore * 0.44 +
        relevance * 0.34 +
        marketBias * 0.18 +
        trust * 0.03 +
        tie * 0.01;

      return it;
    })
    .sort((a, b) => b.__rank - a.__rank);
}

// -------------------- Rate limit --------------------
const visionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// -------------------- Vision prompt (maximum accuracy, brand-expert) --------------------
const VISION_SYSTEM = `
You are Evan AI — the world's most accurate resale-first visual identity extractor.
Your output drives real marketplace searches. Wrong identifications = wrong prices = financial harm to users.
Be a trained resale expert, not a generic image captioner.

Return ONLY valid JSON matching the schema below. No extra text.

SCHEMA
{
  "query": string|null,
  "variants": string[],
  "confidence": number,
  "attributeCertainty": {
    "brand": number,
    "model": number,
    "category": number,
    "condition": number,
    "authenticity": number,
    "resaleConfidence": number
  },
  "identity": {
    "itemType": string|null,
    "category": string|null,
    "brand": string|null,
    "model": string|null,
    "colors": string[],
    "materials": string[],
    "patterns": string[],
    "styleWords": string[],
    "visibleText": string[],
    "condition": string|null,
    "conditionNotes": string|null,
    "sizeHint": string|null,
    "exactQuery": string|null,
    "searchQueries": string[]
  },
  "authenticityFlags": string[],
  "conditionFlags": string[]
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 1 — BRAND VISUAL TELLS (expert recognition)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SNEAKERS
Nike: Swoosh shape (curved, tapered tip), font on heel tab, Air unit visibility, sole waffle pattern on Waffle/Cortez
Jordan: Jumpman silhouette (legs spread, ball visible), wing logo on Air Jordan 1/3/4/5, "NIKE AIR" on early retros
Adidas: Three parallel stripes (always consistent width/spacing), Trefoil logo, Stan Smith perforations, Boost foam texture
New Balance: Block "N" with stitching detail, suede toe box, gum sole pattern
Converse: Star-ankle badge, canvas texture, rubber toe cap, Chuck Taylor signature patch
Vans: Waffle sole pattern, side stripe ("jazz stripe"), Off The Wall tag
Yeezy: Primeknit texture, wavy sole pattern on 350/380, 700 dad shoe silhouette with boost sole
Travis Scott: reversed Swoosh on AF1/Jordan collab, special hang tag
Off-White: zip tie tag, quotation marks on uppers, "THE TEN" text, industrial belt lacing

LUXURY BAGS
Louis Vuitton: LV monogram (repeating LV with fleur-de-lis and 4-petal flower), Damier checkerboard (exact grid), Epi leather grain pattern, golden hardware with LV stamp, date code format (letters+numbers), LOUIS VUITTON text on interior, red microfiber lining on some lines
Chanel: interlocked C logo (mirror image, equal size), quilted diamond pattern (consistent), chain strap (gold or silver links), serial sticker inside pocket (white/black), CC turn-lock clasp
Gucci: interlocked GG (slightly different size G), Gucci stripe (green-red-green or blue-red-blue), horsebit hardware, bamboo handle, Gucci Guccissima leather emboss
Hermes: HERMÈS PARIS stamping (capital letters, precise placement), Clochette bell-shaped key holder, blind stamp (year letter), Palladium or Gold hardware (Birkin/Kelly), saddle stitching visible on edges
Prada: inverted triangle logo (enameled or metal), Saffiano leather cross-hatch texture, nylon ripstop weave, interior PRADA MILANO tag
Balenciaga: City bag motorcycle hardware, Le Dix Cartable boxy shape
Saint Laurent: YSL interlocked logo, Loulou chain bag silhouette

WATCHES
Rolex: Crown logo (5-point), cyclops date magnifier (2.5x), jubilee or oyster bracelet link pattern, Mercedes hands, fluted bezel, Rolex text and crown on dial at 12, depth rating text at 6, SWISS MADE at bottom
AP (Audemars Piguet): Royal Oak octagonal bezel (8 screws), Grande Tapisserie dial pattern, Royal Oak Offshore larger crown guards
Patek Philippe: Calatrava cross logo, Geneva Seal, "Patek Philippe Geneve" on dial
Omega: Greek Omega symbol, Seamaster wave dial pattern, Planet Ocean orange text accents, Speedmaster "Professional Moonwatch" text
TAG Heuer: TAG Heuer text on dial, chronograph pushers at 2 and 4, Carrera/Monaco/Aquaracer model text

EYEWEAR
Ray-Ban: RB engraved on lens (small, corner), Ray-Ban text on temple, B&L markings on vintage, Wayfarer/Clubmaster silhouette recognition
Oakley: O logo on temple (often embossed), Unobtainium nose pad, Prizm lens color variants, sports wrap silhouette
Gucci: GG logo on temple hinge area, acetate quality thickness
Versace: Medusa head logo on temple, Greek key pattern inlay
Prada: inverted triangle on temple

STREETWEAR / APPAREL
Supreme: Box logo (exact font: Futura Heavy Oblique, white on red), authentic proportions (box is wider than tall), Camp Cap crown construction
Palace: Tri-ferg triangle logo, correct Palatino font on "Palace Skateboards" text
Off-White: Industrial belt, arrow logo, quotation marks on print text
Stüssy: interlocking S logo, World Tour text, stock logo proportions

ELECTRONICS
Apple: Apple logo (backlit or matte, exact proportion), model text on back (exact format: "iPhone 15 Pro Max" or "MacBook Pro"), storage engraving
Sony: PS logo shape, DualSense controller exact button layout
Nintendo: Switch console vents pattern, Joy-Con rail shape
GameBoy: Nintendo logo placement, screen bezel molding

CARDS / COLLECTIBLES
Pokémon: Pikachu yellow vs counterfeit (off-color), holographic foil pattern on holos (rainbow or galaxy), card stock texture (authentic = smooth with slight blue core visible on edge)
PSA/BGS slabs: label font and hologram authenticity

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 2 — PER-CATEGORY EXTRACTION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SNEAKERS — extract in this order:
1. Brand (logo/text/silhouette)
2. Model name (Air Jordan 1, Yeezy 350, Air Force 1, etc.)
3. Colorway name if on box/tag (e.g. "Chicago", "Bred", "Panda")
4. Exact colors (toe box, upper, swoosh, sole, laces)
5. SKU/style code if visible on box tag
6. Size if visible on box or tongue label
7. Condition: unworn/VNDS/worn (crease lines, sole yellowing, lace dirt)
searchQueries: [brand+model+colorway, brand+model+colors, model name alone, category+brand+color]

WATCHES — extract in this order:
1. Brand (from dial text, crown logo, or case shape)
2. Collection name (Submariner, Speedmaster, Royal Oak, etc.)
3. Reference number if readable on dial, case side, or box
4. Case size if readable
5. Movement (automatic/quartz/manual — from case back or seconds hand sweep)
6. Condition: dial scratches, bezel wear, bracelet stretch, crystal clarity
searchQueries: [brand+model+ref, brand+model, brand+collection, model alone]

LUXURY BAGS — extract in this order:
1. Brand (from logo, hardware stamp, interior tag)
2. Bag model (Neverfull, Speedy, Classic Flap, Birkin, etc.)
3. Size designation (MM/GM/PM, 25/30/35)
4. Material/leather type (monogram canvas, Epi leather, lambskin, caviar, Saffiano)
5. Hardware color (gold-tone, silver-tone, ruthenium)
6. Color of leather/canvas
7. Date code or serial if visible
8. Condition: corner wear, handle patina, hardware scratches, lining condition
searchQueries: [brand+model+size+material, brand+model+material, brand+model, model+brand+color]

ELECTRONICS — extract in this order:
1. Brand (Apple/Samsung/Sony/Nintendo etc.)
2. Device type and exact model name
3. Color/finish
4. Storage capacity if visible (on back engraving or box)
5. Carrier lock status if visible
6. Condition: screen cracks, body scratches, button function visible
searchQueries: [brand+model+storage+color, brand+model+storage, brand+model, model alone]

EYEWEAR — extract in this order:
1. Brand (from temple text, lens engraving, or unmistakable silhouette)
2. Model name if on temple (e.g. RB2140 Wayfarer, Clubmaster)
3. Frame color and material (tortoise acetate, black metal, gold wire)
4. Lens color (clear, green G15, brown gradient, mirrored silver, blue)
5. Frame shape (wayfarer, round, oval, rectangular, cat-eye, aviator, shield)
6. Lens size/bridge if visible on temple (e.g. 52□21)
7. Condition: scratches on lens, frame warping, nose pad condition
DO NOT call tinted lenses "sunglasses" unless UV/sun evidence is clear (gradient tint, polarized label, outdoor use).
DO NOT call glasses "blue light" unless a blue light filter label or coating is visible.
searchQueries: [brand+model+color, brand+frame shape+color, brand+lens color, brand alone]

CLOTHING / APPAREL — extract in this order:
1. Brand (from logo, tag, visible text)
2. Item type (hoodie, tee, jacket, pants, shorts)
3. Specific design/collaboration/collection name if visible on garment
4. Color(s)
5. Size if visible on tag
6. Material if readable on care label
7. Condition: pilling, fading, stains, collar stretch
searchQueries: [brand+item+design name, brand+item+color, brand+collection+item, item+brand]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 3 — CONDITION ASSESSMENT (5-tier)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Assess condition from every visual cue available:

"new" — No wear, tags attached, box present, zero creasing/scuffing
"like_new" — No visible wear, slight storage marks only, VNDS (very near deadstock)
"good" — Light wear, minor scuffs, faint creasing, no structural damage
"fair" — Moderate wear, visible scuffs, notable creasing, some oxidation/yellowing
"poor" — Heavy wear, major damage, sole separation, broken hardware, deep scratches

conditionNotes: describe specific visible issues (e.g. "heel drag on left shoe", "Louis Vuitton canvas crack at corner", "crystal scratch at 3 o'clock")

conditionFlags: list individual observed issues as strings:
["sole_yellowing", "toe_box_creasing", "heel_drag", "lace_dirty", "canvas_cracking", "corner_wear", "hardware_tarnish", "lining_damage", "strap_wear", "screen_crack", "body_scratch", "bezel_wear", "dial_scratch", "lens_scratch", "frame_bent", "pilling", "fade", "stain", "collar_stretch"]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 4 — AUTHENTICITY RED FLAGS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Populate authenticityFlags with any of these if observed:
- "logo_proportions_off" — logo is wrong size, wrong weight, or wrong spacing
- "font_wrong" — text uses wrong typeface (e.g. Supreme box logo in wrong font)
- "hardware_lightweight" — hardware looks plastic or lightweight
- "stitching_uneven" — uneven, loose, or skipped stitches
- "monogram_misaligned" — LV monogram doesn't align at seam
- "lining_wrong_color" — interior color inconsistent with known authentic spec
- "date_code_format_wrong" — LV date code format invalid
- "serial_sticker_wrong" — Chanel serial hologram incorrect format
- "crown_logo_off" — Rolex crown has wrong number of points or proportions
- "cyclops_missing" — Rolex date with no cyclops
- "hangtag_wrong" — Supreme/Nike hangtag wrong font or proportions
- "no_visible_authentication" — item cannot be assessed from available views

If no red flags: authenticityFlags = []

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 5 — QUERY GENERATION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

"query" — the single best resale search query. Always specific. Never generic.
"exactQuery" — the most precise version (include colorway name, SKU, size, ref if known)
"searchQueries" — array of 6-10 queries, ordered from most specific to most broad:
  [0] brand + model + colorway/edition + year (most specific)
  [1] brand + model + colorway
  [2] brand + model + primary color
  [3] brand + model
  [4] model name alone (if recognizable)
  [5] brand + item type + color
  [6] brand + item type
  [7] item type + color + material
  [8] item type (broadest useful)
"variants" — alternate spellings, abbreviations, regional names for the same item

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 6 — STRICT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. ONLY grounded evidence. Brand/model ONLY if directly supported by readable text, unmistakable logo, or signature design feature.
2. DO NOT invent: colorway names, collaboration names, years, editions, model numbers you cannot see.
3. DO NOT hallucinate: if a logo is blurry, mark brand confidence low — do not guess.
4. DO NOT default to generic: never return "shoes", "bag", "jacket" as query when more specific terms are possible.
5. visibleText: ONLY text that is actually legible. Short fragments OK. No guesses.
6. conditionNotes + conditionFlags: be specific. Vague notes are useless.
7. sizeHint: Only from visible box tag, tongue label, or care label. Never estimate from proportions.
8. If only broad category is knowable: be broad but honest (e.g. "black leather crossbody bag").
9. If image is truly unidentifiable: query=null, confidence=0.

You are seeing multiple views of the same item. Synthesize all views into ONE unified output.
`.trim();

function modeHeader(mode, propContext) {
  if (mode === "mark") {
    return `MODE: MAKER'S MARK. Focus ONLY on stamp/engraving/tag text. If unreadable => query=null.`;
  }
  if (mode === "part") {
    return `MODE: PART/COMPONENT. Prefer part numbers + compatibility cues. If not supported => query=null.`;
  }
  if (mode === "label") {
    return `MODE: LABEL. Extract readable ingredients/material/fabric content cues. If unreadable => query=null.`;
  }
  if (mode === "prop") {
    return `MODE: PROP. Use context: "${propContext || "none"}". If only category-level guess => query=null.`;
  }
  if (mode === "box_tag") {
    return `MODE: BOX TAG / HANG TAG / CARE LABEL.
Your ONLY job is to read every character of text on the product box, hang tag, or care label.
Extract with maximum precision:
- Brand name (exactly as printed)
- Model name (exactly as printed, including sub-names like "Retro High OG")
- Style/SKU code (e.g. 555088-061, CT8012-101, GW2868)
- Colorway name (e.g. "Bred", "University Blue", "Black/White")
- Size (e.g. US 10, EU 44, M, L, 32x30)
- MSRP / retail price (e.g. $180.00)
- Colorway color codes (e.g. CW2288-111)
- Country of origin
- Materials listed on care label
Put ALL text you can read into visibleText[]. Even partial text fragments.
If box/tag is not present or unreadable => query=null.`;
  }
  return `MODE: STANDARD ITEM. Identify exact product when supported by evidence.`;
}

function cleanMode(m) {
  const x = safeStr(m, 24).toLowerCase();
  const allowed = new Set(["item", "mark", "part", "label", "prop", "box_tag"]);
  return allowed.has(x) ? x : "item";
}

function uniqueQueries(list = []) {
  const seen = new Set();
  const out = [];

  for (const raw of list || []) {
    const q = normalizeQuery(String(raw || ""));
    if (!q) continue;
    if (seen.has(q)) continue;
    seen.add(q);
    out.push(q);
  }

  return out;
}

function normalizeVariantList(variants = [], primary = null, mode = "item") {
  if (mode !== "item") return [];

  const primaryNorm = normalizeQuery(primary || "");
  const out = [];

  const primaryWantsOrange =
    primaryNorm.includes("orange") ||
    primaryNorm.includes("amber") ||
    primaryNorm.includes("yellow");

  const primaryWantsBlue =
    primaryNorm.includes("blue light") ||
    primaryNorm.includes("blue-light") ||
    primaryNorm.includes("computer") ||
    primaryNorm.includes("gaming") ||
    primaryNorm.includes("block blue") ||
    primaryNorm.includes("blue blocker") ||
    primaryNorm.includes("blue blocking") ||
    primaryNorm.includes("screen");

const primaryWantsWrap = primaryNorm.includes("wrap");
const primaryAllowBlueFallback = false;

for (const raw of Array.isArray(variants) ? variants : []) {
    let q = normalizeVisionQuery(raw, mode);
    q = normalizeQuery(q || "");

    if (!q) continue;
    if (q === primaryNorm) continue;
    if (isGarbageQuery(q)) continue;

    const qHasOrange =
      q.includes("orange") ||
      q.includes("amber") ||
      q.includes("yellow");

    const qHasBlue =
      q.includes("blue light") ||
      q.includes("blue-light") ||
      q.includes("computer") ||
      q.includes("gaming") ||
      q.includes("block blue") ||
      q.includes("blue blocker") ||
      q.includes("blue blocking") ||
      q.includes("screen");

    // If the primary scan is orange eyewear, do NOT allow generic variants
    // that lose the orange identity.
    if (primaryWantsOrange && !qHasOrange) continue;

// Allow blue-light/computer fallback for ambiguous orange wraparound eyewear.
if (!primaryWantsBlue && qHasBlue && !primaryAllowBlueFallback) continue;

    // If the primary is wraparound orange eyewear, reject useless broad drift.
    if (primaryWantsOrange && primaryWantsWrap && q === "wraparound glasses") {
      continue;
    }

    out.push(q);
  }

  return uniqueQueries(out).slice(0, 3);
}

function cleanStringList(list, max = 12) {
  const out = [];
  const seen = new Set();

  for (const raw of Array.isArray(list) ? list : []) {
    const v = safeStr(String(raw || ""), 80).toLowerCase().trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= max) break;
  }

  return out;
}

function normalizeVisionIdentityPayload(raw = null, fallbackQuery = "") {
  if (!raw || typeof raw !== "object") return null;

  const itemType = safeStr(raw.itemType || raw.type || "", 80) || null;
  const category =
    safeStr(raw.category || "", 80) ||
    inferVisionCategory(itemType || fallbackQuery) ||
    null;

  let brand = safeStr(raw.brand || "", 80) || null;
  let model = safeStr(raw.model || "", 100) || null;

  const colors = cleanStringList(raw.colors, 6);
  const materials = cleanStringList(raw.materials, 6);
  const patterns = cleanStringList(raw.patterns, 6);
  const styleWords = cleanStringList(raw.styleWords, 8);
  const visibleText = cleanStringList(raw.visibleText, 8);

  const condition = safeStr(raw.condition || "", 60) || null;
  const sizeHint = safeStr(raw.sizeHint || "", 60) || null;

  const imageHash =
    safeStr(raw.imageHash || raw.image_hash || "", 128) || null;
  
  const escapeRegex = (s = "") =>
    String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const stripNeedlesFromQuery = (query, needles = []) => {
    let out = normalizeQuery(query || "");
    if (!out) return "";

    for (const needle of needles) {
      for (const token of titleTokens(needle || "")) {
        if (!token) continue;
        out = out.replace(new RegExp(`\\b${escapeRegex(token)}\\b`, "gi"), " ");
      }
    }

    return normalizeQuery(out);
  };

  let incomingExact =
    safeStr(raw.exactQuery || "", 220) ||
    safeStr(fallbackQuery || "", 220) ||
    null;

  let searchQueries = uniqueQueries([
    incomingExact,
    ...(Array.isArray(raw.searchQueries) ? raw.searchQueries : []),
    fallbackQuery,
  ]).slice(0, 20);

  const visibleBlob = visibleText.join(" ").trim();

  const isEyewearIdentity =
    category === "eyewear" ||
    /\b(glasses|sunglasses|eyewear|frames|lens)\b/i.test(
      `${itemType || ""} ${incomingExact || ""} ${searchQueries.join(" ")}`
    );

  // IMPORTANT:
  // For eyewear, brand/model guesses are too easy to hallucinate from shape alone.
  // Keep them only when readable visible text supports them.
  if (isEyewearIdentity && (brand || model)) {
    const brandSupportedByText =
      !!brand &&
      visibleBlob.length > 0 &&
      titleContainsLoose(visibleBlob, brand);

    const modelSupportedByText =
      !!model &&
      visibleBlob.length > 0 &&
      titleContainsLoose(visibleBlob, model);

    if (!brandSupportedByText && !modelSupportedByText) {
      const needles = [brand, model].filter(Boolean);

      brand = null;
      model = null;

      incomingExact =
        stripNeedlesFromQuery(incomingExact, needles) ||
        stripNeedlesFromQuery(fallbackQuery, needles) ||
        null;

      searchQueries = uniqueQueries([
        incomingExact,
        ...searchQueries.map((q) => stripNeedlesFromQuery(q, needles)),
        stripNeedlesFromQuery(fallbackQuery, needles),
      ]).slice(0, 12);
    }
  }

  return {
    itemType,
    category,
    brand,
    model,
    colors,
    materials,
    patterns,
    styleWords,
    visibleText,
    condition,
    sizeHint,
    imageHash,
    exactQuery: searchQueries[0] || incomingExact || null,
    searchQueries,
  };
}


function chooseBestIdentityQuery(identity = null, fallbackQuery = "") {
  const id = normalizeVisionIdentityPayload(identity, fallbackQuery);
  const fallback = normalizeQuery(fallbackQuery || "");

  if (!id) return fallback;

  const brandNeedle = normalizeTitleKey(id.brand || "");
  const modelNeedle = normalizeTitleKey(id.model || "");
  const itemTypeNeedle = normalizeTitleKey(id.itemType || "");

  const colorNeedles = Array.isArray(id.colors)
    ? id.colors.map((x) => normalizeTitleKey(x)).filter(Boolean)
    : [];

  const candidates = uniqueQueries([
    id.exactQuery,
    ...(Array.isArray(id.searchQueries) ? id.searchQueries : []),
    fallback,
  ]);

  if (!candidates.length) return fallback;

  const scored = candidates
    .map((candidate) => {
      const q = normalizeQuery(candidate || "");
      if (!q) return null;

      const tokenCount = titleTokens(q).length;

      let score = tokenCount * 8;

      if (brandNeedle && titleContainsLoose(q, brandNeedle)) score += 34;
      if (modelNeedle && titleContainsLoose(q, modelNeedle)) score += 42;
      if (itemTypeNeedle && titleContainsLoose(q, itemTypeNeedle)) score += 10;

      for (const c of colorNeedles) {
        if (titleContainsLoose(q, c)) score += 4;
      }

      if (/\b(sunglasses|glasses|eyewear|frames|lens)\b/i.test(q)) score += 8;
      if (/\b(orange|amber|yellow|black|brown|white)\b/i.test(q)) score += 6;
      if (/\b(wrap|wraparound|shield|oval|round|square|rectangle|aviator)\b/i.test(q)) score += 6;

      return { q, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.q || fallback;
}

function buildIdentityDrivenQuerySet(primaryQuery = "", variants = [], identity = null) {
  const base = normalizeQuery(primaryQuery);
  const out = [];

  const push = (...parts) => {
    const q = normalizeQuery(
      parts
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    );
    if (q) out.push(q);
  };

  push(base);

  for (const v of uniqueQueries(variants || [])) {
    push(v);
  }

  const id = normalizeVisionIdentityPayload(identity, base);
  if (!id) {
    return uniqueQueries(out).slice(0, 28);
  }

  const c1 = id.colors?.[0] || "";
  const c2 = id.colors?.[1] || "";
  const m1 = id.materials?.[0] || "";
  const p1 = id.patterns?.[0] || "";
  const s1 = id.styleWords?.[0] || "";
  const t1 = id.visibleText?.[0] || "";
  const itemType = id.itemType || "";
  const brand = id.brand || "";
  const model = id.model || "";

  if (id.exactQuery) push(id.exactQuery);
  for (const q of id.searchQueries || []) push(q);

  // exact-to-broad ladder
  push(brand, model, itemType, c1, m1);
  push(brand, model, itemType, c1);
  push(brand, itemType, c1, m1);
  push(brand, itemType, c1);
  push(brand, itemType, m1);
  push(itemType, c1, c2, m1, s1);
  push(itemType, c1, m1, p1);
  push(itemType, c1, s1);
  push(itemType, c1, m1);
  push(itemType, c1);
  push(itemType, m1);
  push(itemType, p1);
  push(itemType, t1);

  if (brand && t1) push(brand, itemType, t1);
  if (brand && model && t1) push(brand, model, t1);

  return uniqueQueries(out).slice(0, 16);
}

function titleContainsLoose(title = "", needle = "") {
  const t = normalizeTitleKey(title);
  const n = normalizeTitleKey(needle);
  if (!t || !n) return false;

  if (t.includes(n)) return true;

  const nt = titleTokens(n);
  const tt = new Set(titleTokens(t));
  if (!nt.length) return false;

  let hits = 0;
  for (const x of nt) {
    if (tt.has(x)) hits++;
  }

  return hits >= Math.max(1, Math.ceil(nt.length * 0.7));
}

function listingIdentityScore(item, identity = null) {
  const id = normalizeVisionIdentityPayload(identity);
  if (!id) return 0;

  const title = String(item?.title || "");
  if (!title) return 0;

  let score = 0;

  if (id.brand && titleContainsLoose(title, id.brand)) score += 0.30;
  if (id.model && titleContainsLoose(title, id.model)) score += 0.26;
  if (id.itemType && titleContainsLoose(title, id.itemType)) score += 0.18;

  for (const c of id.colors || []) {
    if (titleContainsLoose(title, c)) score += 0.07;
  }

  for (const m of id.materials || []) {
    if (titleContainsLoose(title, m)) score += 0.07;
  }

  for (const p of id.patterns || []) {
    if (titleContainsLoose(title, p)) score += 0.06;
  }

  for (const s of id.styleWords || []) {
    if (titleContainsLoose(title, s)) score += 0.06;
  }

  for (const txt of id.visibleText || []) {
    if (titleContainsLoose(title, txt)) score += 0.10;
  }

  return clamp01(score);
}

function buildServerQueryVariants(primaryQuery, modelVariants = [], mode = "item", identity = null) {
  const primary = normalizeVisionQuery(primaryQuery, mode) || primaryQuery;
  const base = normalizeQuery(primary || "");
  if (!base) return [];

  if (mode !== "item") {
    return uniqueQueries([base, ...normalizeVariantList(modelVariants, base, mode)]).slice(0, 8);
  }

  const out = new Set();

  for (const q of buildIdentityDrivenQuerySet(base, modelVariants, identity)) {
    out.add(q);
  }

  for (const v of buildExactVisualSearchLadder(base, modelVariants)) {
    out.add(v);
  }

  for (const v of normalizeVariantList(modelVariants, base, mode)) {
    out.add(v);
  }

  for (const v of buildGoogleShoppingVariants(base, modelVariants)) {
    out.add(v);
  }

const expanded = uniqueQueries([...out])
  .filter(Boolean)
  .filter((x) => x !== "glasses" && x !== "eyewear");

const isEyewear =
  /\b(glasses|eyewear|frames|sunglasses|lens)\b/i.test(base);

const enhanced = new Set();

// keep the strongest direct queries first
for (const q of expanded.slice(0, isEyewear ? 2 : 5)) {
  enhanced.add(q);
}

if (!isEyewear) {
  for (const q of expanded.slice(0, 3)) {
    enhanced.add(`${q} used`);
    enhanced.add(`${q} pre owned`);
    enhanced.add(`${q} resale`);
    enhanced.add(`${q} ebay`);
    enhanced.add(`${q} marketplace`);
    enhanced.add(`${q} second hand`);
    enhanced.add(`${q} vintage`);
    enhanced.add(`${q} collectible`);
  }
}

return uniqueQueries([...enhanced]).slice(0, isEyewear ? 2 : 8);
}

function buildDemandLabel(prob) {
  if (prob >= 0.78) return "High";
  if (prob >= 0.52) return "Medium";
  return "Low";
}

function buildSellThroughDays(prob) {
  if (prob >= 0.82) return 5;
  if (prob >= 0.72) return 8;
  if (prob >= 0.62) return 12;
  if (prob >= 0.52) return 18;
  return 30;
}

function buildFlipPrediction({
  items = [],
  scannedPrice = null,
  visionConfidence = 0.5,
  category = null,
}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];

  const prices = list
    .map((i) => i?.totalPrice ?? i?.price)
    .filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  const medianPrice = median(prices);
  const q1 = quantile(prices, 0.25);
  const q3 = quantile(prices, 0.75);
  const listingCount = list.length;
  const marketConf = marketConfidence(list);
  const resaleProb = resaleProbability(
    list.map((i) => ({
      ...i,
      price: i?.totalPrice ?? i?.price,
    }))
  );

  const demandMultiplier = clamp01(
    0.45 +
      Math.min(listingCount / 20, 1) * 0.25 +
      marketConf * 0.20 +
      Math.min(resaleProb, 1) * 0.10
  );

  const estimatedResale =
    typeof medianPrice === "number"
      ? round2(medianPrice * 0.94)
      : finitePrice(list[0]?.totalPrice ?? list[0]?.price);

  const buyPrice = finitePrice(scannedPrice);
  const expectedProfit =
    buyPrice != null && estimatedResale != null
      ? round2(Math.max(0, estimatedResale - buyPrice))
      : null;

  const sellThroughProbability = clamp01(
    marketConf * 0.45 +
      Math.min(listingCount / 14, 1) * 0.20 +
      clamp01(visionConfidence) * 0.20 +
      Math.min(resaleProb, 1) * 0.15
  );

  const rawFlipScore =
    expectedProfit == null
      ? null
      : Math.round(
          Math.max(
            0,
            Math.min(
              100,
              expectedProfit * 2.1 +
                sellThroughProbability * 28 +
                marketConf * 18 +
                demandMultiplier * 14
            )
          )
        );

  const flipScore = Number.isFinite(rawFlipScore) ? rawFlipScore : null;
  const demand = buildDemandLabel(sellThroughProbability);
  const sellThroughDays = buildSellThroughDays(sellThroughProbability);

  const label =
    flipScore == null
      ? "Unknown"
      : flipScore >= 82
      ? "🔥 Flip Opportunity"
      : flipScore >= 65
      ? "🟢 Strong Resale"
      : flipScore >= 45
      ? "👌 Decent Flip"
      : "⚠️ Weak Flip";

  return {
    category: category || null,
    medianPrice: finitePrice(medianPrice),
    estimatedResale: finitePrice(estimatedResale),
    expectedProfit: finitePrice(expectedProfit),
    flipScore,
    sellThroughProbability: Math.round(sellThroughProbability * 100),
    demand,
    sellThroughDays,
    marketConfidence: Math.round(marketConf * 100),
    listingCount,
    typicalLow: finitePrice(q1),
    typicalHigh: finitePrice(q3),
    label,
  };
}

function buildResaleCoach({
  prediction,
  consensus,
  scannedPrice = null,
  finalQuery = "",
}) {
  const flipScore = Number(prediction?.flipScore || 0);
  const expectedProfit = Number(prediction?.expectedProfit || 0);
  const marketConfidence = Number(prediction?.marketConfidence || 0);
  const thinMarket = !!consensus?.thinMarket;
  const suspiciousMarket = !!consensus?.suspiciousMarket;

  let headline = "⚠️ Weak flip — only buy if you personally want it";

  if (flipScore >= 82) {
    headline = "🔥 Buy signal — this looks like a real flip";
  } else if (flipScore >= 65) {
    headline = "🟢 Strong opportunity — worth grabbing if condition is clean";
  } else if (flipScore >= 45) {
    headline = "👌 Borderline flip — negotiate if possible";
  }

  const bullets = [];

  if (expectedProfit >= 25) {
    bullets.push("Profit room is strong enough to absorb normal fees and shipping.");
  } else if (expectedProfit >= 10) {
    bullets.push("There is usable margin here, but resale friction matters.");
  } else {
    bullets.push("Margin looks thin, so entry price discipline matters.");
  }

  if (thinMarket) {
    bullets.push("Market depth is thin, so comps are less stable than usual.");
  } else if (suspiciousMarket) {
    bullets.push("Listing quality is noisy, so verify condition before buying.");
  } else if (marketConfidence >= 70) {
    bullets.push("Market signals look stable enough to trust this pricing range.");
  } else {
    bullets.push("Market confidence is moderate, so treat resale value as an estimate.");
  }

  if (flipScore >= 82) {
    bullets.push("This is the kind of item Evan AI should aggressively highlight.");
  } else if (flipScore >= 65) {
    bullets.push("Good flip candidate if the actual item matches the comp condition.");
  } else {
    bullets.push("More of a fair-value buy than a premium resale opportunity.");
  }

  return {
    headline,
    bullets: bullets.slice(0, 3),
    finalQuery: finalQuery || null,
    scannedPrice: finitePrice(scannedPrice),
  };
}

function syncQueryPulseFromRedis(query = "") {
  const key = canonicalMarketQuery(query);
  if (!key) return;

  scheduleRedisStateRefresh(queryPulseCacheKey(key), (remote) => {
    if (!Array.isArray(remote)) return;
    QUERY_PULSE.set(key, distributedListTrim(remote));
  });
}

function getPulse(query = "") {
  const key = canonicalMarketQuery(query);
  if (!key) {
    return {
      query: null,
      score: 0,
      label: "Quiet",
      scans24h: 0,
    };
  }

  syncQueryPulseFromRedis(key);

  const active = distributedListTrim(QUERY_PULSE.get(key));
  QUERY_PULSE.set(key, active);

  const scans24h = active.length;
  const score = Math.min(100, scans24h * 8);

  const label =
    score >= 72 ? "Hot" :
    score >= 40 ? "Rising" :
    score >= 16 ? "Active" :
    "Quiet";

  return {
    query: key,
    score,
    label,
    scans24h,
  };
}

function recordPulse(query = "") {
  const key = canonicalMarketQuery(query);
  if (!key) return getPulse(query);

  const now = Date.now();
  const active = distributedListTrim(QUERY_PULSE.get(key));
  active.push(now);

  const next = distributedListTrim(active);
  QUERY_PULSE.set(key, next);
  mirrorStateWrite(queryPulseCacheKey(key), next, 24 * 60 * 60);

  incMetric("query_pulse_record_total", 1, { query: key });

  return getPulse(key);
}

function getTopPulse(limit = 10) {
  return [...QUERY_PULSE.keys()]
    .map((query) => getPulse(query))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, limit);
}

function requireSelfUserId(req, res, next) {
  const resolvedUserId = safeStr(getResolvedUserId(req), 64);

  if (!resolvedUserId) {
    return res.status(401).json({
      ok: false,
      error: "auth_required",
    });
  }

  const incomingUserId =
    safeStr(
      req.body?.userId ||
        req.query?.userId ||
        req.body?.item?.userId,
      64
    ) || resolvedUserId;

  if (incomingUserId !== resolvedUserId) {
    return res.status(403).json({
      ok: false,
      error: "user_mismatch",
    });
  }

  if (req.method === "GET") {
    req.query.userId = resolvedUserId;
  } else {
    req.body = {
      ...(req.body || {}),
      userId: resolvedUserId,
    };

    if (req.body?.item && typeof req.body.item === "object") {
      req.body.item = {
        ...req.body.item,
        userId: resolvedUserId,
      };
    }
  }

  return next();
}

function requireApiKey(req, res, next) {
  const configuredKey = safeStr(process.env.API_KEY, 240);
  const providedKey = safeStr(req.headers["x-api-key"], 240);

  if (!configuredKey) {
    if (IS_PROD) {
      return res.status(503).json({
        ok: false,
        error: "api_key_not_configured",
      });
    }
    return next();
  }

  if (providedKey === configuredKey) {
    return next();
  }

  return res.status(401).json({
    ok: false,
    error: "unauthorized",
  });
}

function safeJsonParse(value, fallback = {}) {
  try {
    if (typeof value !== "string" || !value.trim()) return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function extractFirstJsonObject(text = "") {
  const s = String(text || "").trim();
  if (!s) return null;

  try {
    return JSON.parse(s);
  } catch {}

  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) return null;

  const candidate = s.slice(start, end + 1);

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function salvageVisionFields(rawText = "") {
  const text = String(rawText || "");
  if (!text.trim()) {
    return {
      query: null,
      variants: [],
      confidence: 0,
      identity: null,
    };
  }

  const queryMatch = text.match(/"query"\s*:\s*"([^"]+)"/i);
  const confidenceMatch = text.match(/"confidence"\s*:\s*([0-9.]+)/i);
  const variantsBlockMatch = text.match(/"variants"\s*:\s*\[([\s\S]*?)\]/i);

  const variants = [];
  if (variantsBlockMatch?.[1]) {
    const rx = /"([^"]+)"/g;
    let m;
    while ((m = rx.exec(variantsBlockMatch[1])) !== null) {
      const v = normalizeQuery(m[1] || "");
      if (v) variants.push(v);
      if (variants.length >= 8) break;
    }
  }

  return {
    query: queryMatch?.[1]?.trim() || null,
    variants: uniqueQueries(variants),
    confidence: confidenceMatch?.[1]
      ? clamp01(Number(confidenceMatch[1]))
      : 0,
    identity: null,
  };
}

function buildVisionConsensusSchema() {
    return {
      type: "object",
      additionalProperties: false,
      required: ["query", "variants", "confidence", "attributeCertainty", "identity", "authenticityFlags", "conditionFlags"],
      properties: {
        query: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        variants: {
          type: "array",
          items: { type: "string" },
        },
        confidence: {
          type: "number",
        },
        attributeCertainty: {
          type: "object",
          additionalProperties: false,
          required: ["brand", "model", "category", "condition", "authenticity", "resaleConfidence"],
          properties: {
            brand:            { type: "number" },
            model:            { type: "number" },
            category:         { type: "number" },
            condition:        { type: "number" },
            authenticity:     { type: "number" },
            resaleConfidence: { type: "number" },
          },
        },
        identity: {
          type: "object",
          additionalProperties: false,
          required: [
            "itemType",
            "category",
            "brand",
            "model",
            "colors",
            "materials",
            "patterns",
            "styleWords",
            "visibleText",
            "condition",
            "conditionNotes",
            "sizeHint",
            "exactQuery",
            "searchQueries",
          ],
          properties: {
            itemType:       { anyOf: [{ type: "string" }, { type: "null" }] },
            category:       { anyOf: [{ type: "string" }, { type: "null" }] },
            brand:          { anyOf: [{ type: "string" }, { type: "null" }] },
            model:          { anyOf: [{ type: "string" }, { type: "null" }] },
            colors:         { type: "array", items: { type: "string" } },
            materials:      { type: "array", items: { type: "string" } },
            patterns:       { type: "array", items: { type: "string" } },
            styleWords:     { type: "array", items: { type: "string" } },
            visibleText:    { type: "array", items: { type: "string" } },
            condition:      { anyOf: [{ type: "string" }, { type: "null" }] },
            conditionNotes: { anyOf: [{ type: "string" }, { type: "null" }] },
            sizeHint:       { anyOf: [{ type: "string" }, { type: "null" }] },
            exactQuery:     { anyOf: [{ type: "string" }, { type: "null" }] },
            searchQueries:  { type: "array", items: { type: "string" } },
          },
        },
        authenticityFlags: {
          type: "array",
          items: { type: "string" },
        },
        conditionFlags: {
          type: "array",
          items: { type: "string" },
        },
      },
    };
  }

function buildVisionPassPrompt(passLabel, mode, propContext) {
  const header = modeHeader(mode, propContext);


    if (passLabel === "counterfactual_alt1") {
      return `${header}

  PASS: ALTERNATE IDENTITY — ALT 1
  Prior context: ${propContext || "none"}

  You must propose an ALTERNATIVE identity for this item that is DIFFERENT from the most obvious guess.
  Consider the second most likely category, brand, or use-case.
  Be honest about what you can and cannot see. Do not force a brand if text is unreadable.
  Return the strongest ALTERNATE resale search identity.`;
    }

    if (passLabel === "counterfactual_alt2") {
      return `${header}

  PASS: ALTERNATE IDENTITY — ALT 2
  Prior context: ${propContext || "none"}

  You must propose a THIRD possible identity for this item, different from both the primary and alternate.
  Explore an adjacent category, industrial use, or niche application.
  Be honest. Return the strongest THIRD-OPTION resale search identity.`;
    }

    if (passLabel === "brand_model") {
      return `${header}

  PASS: BRAND + MODEL EXTRACTION

Focus on:
- logos
- readable text
- maker marks
- model names
- exact visible identifiers

Return the strongest resale search identity possible.
If brand/model are unclear, stay honest and broad.`;
  }

  if (passLabel === "visual_shape") {
    return `${header}

PASS: VISUAL SHAPE + MATERIAL + COLOR

Focus on:
- silhouette
- category
- colors
- materials
- shape words
- fashion/style cues
- lens/frame traits if eyewear

Return the strongest visually grounded resale search identity possible.`;
  }

  return `${header}

PASS: MASTER RESALE SEARCH

Build the best marketplace search identity for this item.
Prioritize exact matching and near-replica resale search usefulness.
Return only grounded evidence.`;
}

async function runVisionPass({ dataUrl, mode, propContext, passLabel, rid }) {
  const timeout = withTimeout(VISION_TIMEOUT_MS);

  try {

const response = await withModelServing(
  `vision_pass:${passLabel}`,
  () =>
    withHardTimeout(
      openai.responses.create(
        {
          model: VISION_MODEL,
          temperature: 0.1,
          max_output_tokens: 900,
          prompt_cache_key: `evan-ai-vision-${passLabel}-v5`,
          prompt_cache_retention: "24h",
          text: {
            format: {
              type: "json_schema",
              name: `evan_ai_vision_${passLabel}`,
              strict: true,
              schema: buildVisionConsensusSchema(),
            },
          },
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: VISION_SYSTEM }],
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: buildVisionPassPrompt(passLabel, mode, propContext),
                },
                {
                  type: "input_image",
                  image_url: dataUrl,
                },
              ],
            },
          ],
          metadata: {
            rid: rid || "",
            mode,
            pass: passLabel,
          },
        },
        { signal: timeout.signal }
      ),
      VISION_TIMEOUT_MS + 1500,
      `vision_pass_timeout:${passLabel}`
    ),
  {
    provider: "openai",
    model: VISION_MODEL,
    maxConsecutiveFailures: 4,
    circuitMs: 60_000,
  }
);

    timeout.cancel();

const rawText =
  typeof response?.output_text === "string" && response.output_text.trim()
    ? response.output_text
    : Array.isArray(response?.output)
    ? response.output
        .flatMap((block) => (Array.isArray(block?.content) ? block.content : []))
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .find((x) => x && x.trim()) || ""
    : "";

const parsedRaw =
  safeJsonParse(rawText, null) || extractFirstJsonObject(rawText) || null;

const salvaged = salvageVisionFields(rawText);

const parsed = {
  query:
    typeof parsedRaw?.query === "string" && parsedRaw.query.trim()
      ? parsedRaw.query.trim()
      : salvaged.query,
  variants:
    Array.isArray(parsedRaw?.variants) && parsedRaw.variants.length
      ? uniqueQueries(parsedRaw.variants)
      : salvaged.variants,
  confidence: Number.isFinite(Number(parsedRaw?.confidence))
    ? clamp01(Number(parsedRaw.confidence))
    : salvaged.confidence,
  identity:
    parsedRaw?.identity && typeof parsedRaw.identity === "object"
      ? parsedRaw.identity
      : null,
};

console.log("🧾 VISION PASS RAW", {
  rid: rid || "",
  pass: passLabel,
  parsedQuery: parsed.query,
  parsedConfidence: parsed.confidence,
  rawPreview: String(rawText || "").slice(0, 280),
});

return {
  rawText,
  parsed,
};

} catch (err) {
  timeout.cancel?.();

  console.warn("❌ VISION PASS FAILED", {
    rid: rid || "",
    pass: passLabel,
    error: err?.message || err,
  });

  return {
    rawText: "",
    parsed: {},
    error: err?.message || "vision_pass_failed",
  };
}
}

async function runVisionRecoveryPass({ req, file, mode, propContext }) {
  const base64 = file.buffer.toString("base64");
  const dataUrl = `data:${file.mimetype || "image/jpeg"};base64,${base64}`;
  const timeout = withTimeout(7000);

  try {
    const response = await withModelServing(
      "vision_recovery",
      () =>
        withHardTimeout(
          openai.responses.create(
            {
              model: VISION_MODEL,
              temperature: 0.1,
              max_output_tokens: 350,
              text: {
                format: {
                  type: "json_schema",
                  name: "evan_ai_vision_recovery",
                  strict: true,
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["query", "variants", "confidence"],
                    properties: {
                      query: { anyOf: [{ type: "string" }, { type: "null" }] },
                      variants: {
                        type: "array",
                        items: { type: "string" },
                      },
                      confidence: { type: "number" },
                    },
                  },
                },
              },
              input: [
                {
                  role: "system",
                  content: [
                    {
                      type: "input_text",
text:
  "You are Evan AI — a resale expert with encyclopedic knowledge of sneakers, luxury bags, watches, apparel, electronics, and eyewear. You have ONE job: return the most specific, accurate marketplace search query possible for the item in the photo. Rules: (1) Be specific — include brand + model + color whenever visible. (2) Never return generic words like 'item', 'object', 'product', 'shoes', 'bag', 'jacket' alone — always add identifying details. (3) For sneakers: brand + model name + colorway. (4) For luxury bags: brand + model + size + material. (5) For watches: brand + model + reference if visible. (6) For eyewear: brand + model/shape + frame color + lens color. Do NOT call tinted glasses 'sunglasses' unless sun-blocking purpose is clear. Do NOT call glasses 'safety glasses' unless industrial PPE cues are present. (7) Use the variants array for 2-4 alternate spellings or search phrasings. (8) confidence = probability that searching this query returns accurate resale comps.",
                    },
                  ],
                },
                {
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text: `Recovery mode. Original mode: ${mode}. Context: ${propContext || "none"}. Return the strongest resale search query you can.`,
                    },
                    {
                      type: "input_image",
                      image_url: dataUrl,
                    },
                  ],
                },
              ],
              metadata: {
                rid: req.rid || "",
                mode,
                pass: "recovery",
              },
            },
            { signal: timeout.signal }
          ),
          8000,
          "vision_recovery_timeout"
        ),
      {
        provider: "openai",
        model: VISION_MODEL,
        maxConsecutiveFailures: 4,
        circuitMs: 45_000,
      }
    );
    timeout.cancel();

    const rawText =
      typeof response?.output_text === "string" && response.output_text.trim()
        ? response.output_text
        : Array.isArray(response?.output)
        ? response.output
            .flatMap((block) => (Array.isArray(block?.content) ? block.content : []))
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .find((x) => x && x.trim()) || ""
        : "";

    const parsedRaw =
      safeJsonParse(rawText, null) || extractFirstJsonObject(rawText) || {};

    const query =
      typeof parsedRaw?.query === "string" && parsedRaw.query.trim()
        ? parsedRaw.query.trim()
        : null;

    const variants = Array.isArray(parsedRaw?.variants) ? parsedRaw.variants : [];
    const confidence = Number.isFinite(Number(parsedRaw?.confidence))
      ? clamp01(Number(parsedRaw.confidence))
      : 0.55;

    console.log("🛟 VISION RECOVERY RESULT", {
      rid: req.rid || "",
      query,
      confidence,
      rawPreview: String(rawText || "").slice(0, 220),
    });

    return { query, variants, confidence };
  } catch (err) {
    timeout.cancel?.();

    console.warn("❌ VISION RECOVERY FAILED", {
      rid: req.rid || "",
      error: err?.message || err,
    });

    return {
      query: null,
      variants: [],
      confidence: 0,
    };
  }
}

function chooseMostSpecificVisionQuery(candidates = []) {
  const cleaned = candidates
    .map((q) => normalizeQuery(q || ""))
    .filter(Boolean)
    .filter((q) => !isGarbageQuery(q));

  if (!cleaned.length) return null;

  const scored = cleaned
    .map((q) => {
      const tokens = q.split(" ").filter(Boolean);

let score = tokens.length * 10;

if (/\b(oakley|rayban|ray-ban|gucci|prada|nike|adidas)\b/i.test(q)) {
  score += 10;
}

if (tokens.length >= 4) score += 12;
if (tokens.length >= 5) score += 8;

      // item categories
      if (/\b(glasses|sunglasses|eyewear|hoodie|jacket|sneakers|shoes|hat|bag|backpack|watch|handbag)\b/i.test(q)) {
        score += 12;
      }

      // color detection
      if (/\b(orange|amber|yellow|black|white|blue|brown|silver|gold|red|green|purple|pink)\b/i.test(q)) {
        score += 6;
      }

      // shape / style detection
      if (/\b(wraparound|shield|aviator|oval|round|square|rectangle|oversized|rimless|retro|vintage|y2k)\b/i.test(q)) {
        score += 8;
      }

      // lens detection (huge for sunglasses)
      if (/\b(lens|tinted|gradient|mirrored|polarized)\b/i.test(q)) {
        score += 6;
      }

      // blue light detection
      if (/\bblue light|computer glasses|gaming glasses\b/i.test(q)) {
        score += 8;
      }

      return { q, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.q || cleaned[0];
}

function mergeVisionIdentityObjects(objects = [], fallbackQuery = "") {
  const normalized = objects
    .map((x) => normalizeVisionIdentityPayload(x, fallbackQuery))
    .filter(Boolean);

  if (!normalized.length) {
    return normalizeVisionIdentityPayload(null, fallbackQuery);
  }

  const pickFirstTruthy = (key) => {
    for (const obj of normalized) {
      if (obj?.[key]) return obj[key];
    }
    return null;
  };

  const mergeList = (key, max = 8) => {
    return cleanStringList(
      normalized.flatMap((obj) => (Array.isArray(obj?.[key]) ? obj[key] : [])),
      max
    );
  };

  const merged = {
    itemType: pickFirstTruthy("itemType"),
    category: pickFirstTruthy("category"),
    brand: pickFirstTruthy("brand"),
    model: pickFirstTruthy("model"),
    colors: mergeList("colors", 6),
    materials: mergeList("materials", 6),
    patterns: mergeList("patterns", 6),
    styleWords: mergeList("styleWords", 8),
    visibleText: mergeList("visibleText", 8),
    condition: pickFirstTruthy("condition"),
    sizeHint: pickFirstTruthy("sizeHint"),
    exactQuery: pickFirstTruthy("exactQuery"),
    searchQueries: uniqueQueries(
      normalized.flatMap((obj) =>
        Array.isArray(obj?.searchQueries) ? obj.searchQueries : []
      )
    ).slice(0, 12),
  };

  return normalizeVisionIdentityPayload(merged, fallbackQuery);
}

async function runVisionConsensus({ req, file, mode, propContext }) {
  const base64 = file.buffer.toString("base64");
  const dataUrl = `data:${file.mimetype || "image/jpeg"};base64,${base64}`;

  const passes = await Promise.all([
    runVisionPass({
      dataUrl,
      mode,
      propContext,
      passLabel: "master",
      rid: req.rid,
    }),
    runVisionPass({
      dataUrl,
      mode,
      propContext,
      passLabel: "brand_model",
      rid: req.rid,
    }),
    runVisionPass({
      dataUrl,
      mode,
      propContext,
      passLabel: "visual_shape",
      rid: req.rid,
    }),
  ]);

  const parsedList = passes.map((p) => p?.parsed || {});
  const passLabels = ["master", "brand_model", "visual_shape"];

  const passMeta = parsedList.map((parsed, idx) => {
    const query =
      typeof parsed?.query === "string" ? parsed.query.trim() : "";

    const confidence = clamp01(Number(parsed?.confidence || 0));
    const identity = normalizeVisionIdentityPayload(
      parsed?.identity || null,
      query
    );

    const tokenCount = titleTokens(query).length;

    const detailScore =
      (identity?.brand ? 20 : 0) +
      (identity?.model ? 24 : 0) +
      (identity?.itemType ? 8 : 0) +
      Math.min(tokenCount, 7) * 4 +
      confidence * 20 +
      (passLabels[idx] === "brand_model"
        ? 10
        : passLabels[idx] === "master"
        ? 4
        : 0);

    return {
      label: passLabels[idx],
      query,
      confidence,
      identity,
      detailScore,
    };
  });

  const rawQueries = passMeta
    .map((p) => p.query)
    .filter(Boolean);

  const brandedCandidate = passMeta
    .filter(
      (p) =>
        p.query &&
        !isGarbageQuery(p.query) &&
        (p.identity?.brand || p.identity?.model)
    )
    .sort((a, b) => b.detailScore - a.detailScore)[0];

  const strongestAny = passMeta
    .filter((p) => p.query && !isGarbageQuery(p.query))
    .sort((a, b) => b.detailScore - a.detailScore)[0];

  let query =
    brandedCandidate?.query ||
    strongestAny?.query ||
    chooseMostSpecificVisionQuery(rawQueries);

const mergedIdentity = mergeVisionIdentityObjects(
  passMeta.map((p) => p.identity || null),
  query || ""
);

const identityPreferredQuery = chooseBestIdentityQuery(
  mergedIdentity,
  query || ""
);

if (
  identityPreferredQuery &&
  (
    !query ||
    isGarbageQuery(query) ||
    titleTokens(identityPreferredQuery).length >= titleTokens(query || "").length
  )
) {
  query = identityPreferredQuery;
}

if (!query && mergedIdentity?.exactQuery) {
  query = mergedIdentity.exactQuery;
}

if (!query && Array.isArray(mergedIdentity?.searchQueries) && mergedIdentity.searchQueries[0]) {
  query = mergedIdentity.searchQueries[0];
}

  query = stabilizeVisionQuery(
    query,
    normalizeVisionQuery(query, mode),
    mode
  );

if (
  !query ||
  query.length < 6 ||
  isGarbageQuery(query)
) {

  if (mergedIdentity?.exactQuery) {
    query = mergedIdentity.exactQuery;
  }
}

  let confidenceValues = parsedList
    .map((p) => Number(p?.confidence))
    .filter((n) => Number.isFinite(n));

  let confidence =
    confidenceValues.length > 0
      ? clamp01(
          confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length
        )
      : 0;

  let variants = uniqueQueries([
    ...(Array.isArray(parsedList[0]?.variants) ? parsedList[0].variants : []),
    ...(Array.isArray(parsedList[1]?.variants) ? parsedList[1].variants : []),
    ...(Array.isArray(parsedList[2]?.variants) ? parsedList[2].variants : []),
    ...(Array.isArray(mergedIdentity?.searchQueries) ? mergedIdentity.searchQueries : []),
    mergedIdentity?.exactQuery,
  ]);

const consensusLooksEmpty =
  (!query || !String(query).trim() || isGarbageQuery(query)) &&
  (!variants || variants.length === 0) &&
  confidence <= 0.05 &&
  rawQueries.length === 0;

if (consensusLooksEmpty && mode === "item" && getResolvedPlan(req) !== "free") {
  console.warn("⚠️ EMPTY VISION CONSENSUS -> running recovery pass", {
    rid: req.rid,
  });

  const recovery = await runVisionRecoveryPass({
    req,
    file,
    mode,
    propContext,
  });

  if (recovery?.query) {
    query = recovery.query;
    variants = uniqueQueries([
      ...(Array.isArray(recovery?.variants) ? recovery.variants : []),
      ...variants,
    ]);
    confidence = Math.max(confidence, clamp01(Number(recovery?.confidence || 0.55)));
  }
}

if (
  !query ||
  !String(query).trim() ||
  isGarbageQuery(query)
) {


    const fallbackFromMode = () => {
      if (mode === "mark") return "maker's mark";
      if (mode === "part") return "replacement part";
      if (mode === "label") return "product label";
      if (mode === "prop") return "collectible item";

      if (mergedIdentity?.exactQuery) {
        return mergedIdentity.exactQuery;
      }

      if (mergedIdentity?.searchQueries?.length) {
        return mergedIdentity.searchQueries[0];
      }

      const currentCategory =
        mergedIdentity?.category ||
        inferVisionCategory(rawQueries?.[0] || query || "") ||
        inferVisionCategory(mergedIdentity?.itemType || "");

      if (currentCategory) {
        const catFallback = categoryFallback(currentCategory);
        if (catFallback) return catFallback;
      }

      return "consumer product";
    };

    query = fallbackFromMode();
    confidence = Math.max(confidence, 0.41);
  }

  query = stabilizeVisionQuery(
    query,
    normalizeVisionQuery(query, mode) || query,
    mode
  );

  if (isGarbageQuery(query)) {
    const currentCategory =
      mergedIdentity?.category ||
      inferVisionCategory(rawQueries?.[0] || query || "") ||
      inferVisionCategory(mergedIdentity?.itemType || "");

    if (currentCategory) {
      query = categoryFallback(currentCategory) || query;
    }
  }

  if (isGarbageQuery(query)) {
    query = mode === "item" ? "consumer product" : query;
  }


  variants = normalizeVariantList(variants, query, mode);

  if (mode === "item") {
    variants = buildServerQueryVariants(query, variants, mode, mergedIdentity)
      .filter((v) => normalizeQuery(v) !== normalizeQuery(query))
      .slice(0, 8);
  } else {
    variants = [];
  }

  confidence = clamp01(confidence);

  rememberGoodQuery(query);

    // Merge attributeCertainty across all 3 passes
    const rawCertaintyMaps = parsedList
      .map((p) => p?.attributeCertainty)
      .filter((ac) => ac && typeof ac === "object");

    const mergedAttributeCertainty = rawCertaintyMaps.length
      ? mergeAttributeCertaintyMaps(rawCertaintyMaps)
      : inferAttributeCertaintyFromIdentity(mergedIdentity, confidence);

    return {
      ok: true,
      query,
      variants,
      confidence,
      identity: mergedIdentity,
      attributeCertainty: mergedAttributeCertainty,
      debug: {
        passQueries: rawQueries,
      },
    };
  }


app.get("/auth/me", (req, res) => {
  if (!getResolvedUserId(req)) {
    return res.status(401).json({
      ok: false,
      error: "auth_required",
    });
  }

  return res.status(200).json({
    ok: true,
    auth: req.auth || {
      userId: getResolvedUserId(req),
      plan: getResolvedPlan(req),
      roles: [],
    },
  });
});

app.post("/upload/presign", requireProductAccess, async (req, res) => {
  try {
    const userId = getResolvedUserId(req);
    const contentType = safeStr(req.body?.contentType, 120) || "image/jpeg";
    const filename = safeStr(req.body?.filename, 220) || "";
    const sizeBytes = Math.min(
      MAX_UPLOAD_BYTES,
      Math.max(1, Number(req.body?.sizeBytes || MAX_UPLOAD_BYTES))
    );

    if (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(contentType)) {
      return res.status(200).json({
        ok: false,
        error: "invalid_file_type",
      });
    }

    const session = await createDirectUploadSession({
      userId,
      contentType,
      sizeBytes,
      filename,
    });

    return res.status(200).json({
      ok: true,
      ...session,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "presign_failed",
      reason: err?.message || String(err),
    });
  }
});

app.put(
  "/upload/direct/:ticketId",
  express.raw({ type: "*/*", limit: MAX_UPLOAD_BYTES }),
  async (req, res) => {
    try {
      const ticketId = safeStr(req.params?.ticketId, 160);
      const ticket = await readUploadTicket(ticketId);

      if (!ticket || Number(ticket.expiresAt || 0) <= Date.now()) {
        return res.status(403).json({
          ok: false,
          error: "upload_ticket_expired",
        });
      }

      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      if (!body.length) {
        return res.status(200).json({
          ok: false,
          error: "empty_upload_body",
        });
      }

      if (body.length > Number(ticket.maxBytes || MAX_UPLOAD_BYTES)) {
        return res.status(200).json({
          ok: false,
          error: "upload_too_large",
        });
      }

      await objectStorePutBuffer(
        ticket.objectKey,
        body,
        ticket.contentType || req.headers["content-type"] || "application/octet-stream",
        {
          userId: ticket.userId || "anon",
          uploadType: "scan_raw",
        }
      );

      await deleteUploadTicket(ticketId);

      return res.status(200).json({
        ok: true,
        objectKey: ticket.objectKey,
      });
    } catch (err) {
      return res.status(200).json({
        ok: false,
        error: "direct_upload_failed",
        reason: err?.message || String(err),
      });
    }
  }
);

app.post("/upload/complete", requireProductAccess, async (req, res) => {
  try {
    const objectKey = safeStr(req.body?.objectKey, 320);
    const explicitType = safeStr(req.body?.contentType, 120) || null;

    if (!objectKey) {
      return res.status(200).json({
        ok: false,
        error: "missing_object_key",
      });
    }

    const buffer = await objectStoreReadBuffer(objectKey);
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      return res.status(200).json({
        ok: false,
        error: "uploaded_object_not_found",
      });
    }

    const mimetype = explicitType || guessMimeFromKey(objectKey);
    const file = {
      fieldname: "image",
      originalname: path.basename(objectKey),
      mimetype,
      size: buffer.length,
      buffer,
    };

    if (buffer.length < 4000) {
      return res.status(200).json({
        ok: false,
        error: "image_too_small",
      });
    }

    const imageHash = sha256(buffer);
    const stored = await persistScanArtifacts(file, imageHash);

    const embeddingJobId = enqueueBackgroundJob(
      "warm_scan_embedding",
      { imageHash },
      async () => {
        const vector = await getOrCreateStoredEmbedding(
          imageHash,
          stored.processedBuffer
        );

        return {
          ok: !!(Array.isArray(vector) && vector.length),
          imageHash,
          dims: Array.isArray(vector) ? vector.length : 0,
        };
      }
    );

    return res.status(200).json({
      ok: true,
      imageHash,
      objectKey,
      asset: stored.asset,
      preprocess: stored.preprocess,
      embeddingJobId,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "upload_complete_failed",
      reason: err?.message || String(err),
    });
  }
});

app.post(
  ["/upload/image", "/api/upload/image"],
  requireApiKey,
  upload.single("image"),
  createUploadIdempotencyMiddleware("upload_image"),
  async (req, res) => {
    try {
      const file = req.file || null;

      if (!file) {
        return res.status(200).json({
          ok: false,
          error: "no_file_received",
        });
      }

      if (!Buffer.isBuffer(file.buffer) || file.buffer.length < 4000) {
        return res.status(200).json({
          ok: false,
          error: "image_too_small",
        });
      }

      const imageHash = sha256(file.buffer);
      const stored = await persistScanArtifacts(file, imageHash);

      const embeddingJobId = enqueueBackgroundJob(
        "warm_scan_embedding",
        { imageHash },
        async () => {
          const vector = await getOrCreateStoredEmbedding(
            imageHash,
            stored.processedBuffer
          );

          return {
            ok: !!(Array.isArray(vector) && vector.length),
            imageHash,
            dims: Array.isArray(vector) ? vector.length : 0,
          };
        }
      );

      return res.status(200).json({
        ok: true,
        imageHash,
        asset: stored.asset,
        preprocess: stored.preprocess,
        embeddingJobId,
      });
    } catch (err) {
      return res.status(200).json({
        ok: false,
        error: "upload_failed",
        reason: err?.message || String(err),
      });
    }
  }
);

// -------------------- VISION ANALYZE --------------------
app.get(["/vision/analyze", "/api/vision/analyze"], (_req, res) => {
  res.status(200).json({
    ok: true,
    hint: 'POST multipart/form-data with field name "image"',
  });
});

app.post(
  ["/vision/analyze", "/api/vision/analyze"],
  visionLimiter,
  requireProductAccess,
  upload.single("image"),
  async (req, res) => {
    try {
const uploadedObjectKey =
  safeStr(
    req.body?.imageKey ||
      req.body?.objectKey ||
      req.body?.scanAsset?.processedKey ||
      req.body?.scanAsset?.originalKey,
    320
  ) || null;

let file = req.file || null;

if (!file && uploadedObjectKey) {
  const objectBuffer = await objectStoreReadBuffer(uploadedObjectKey);

  if (Buffer.isBuffer(objectBuffer) && objectBuffer.length) {
    file = {
      fieldname: "image",
      originalname: path.basename(uploadedObjectKey),
      encoding: "7bit",
      mimetype: guessMimeFromKey(uploadedObjectKey),
      size: objectBuffer.length,
      buffer: objectBuffer,
    };
  }
}

      console.log("📸 VISION HIT", {
        rid: req.rid,
        path: req.originalUrl,
        hasFile: !!file,
        fileField: file?.fieldname || null,
        fileSize: file?.size || 0,
        bodyMode: req.body?.mode,
        contentType: req.headers["content-type"],
      });

      if (!file) {
        return res.status(200).json({
          ok: true,
          query: null,
          variants: [],
          confidence: 0,
          identity: null,
          visionIdentity: null,
          reason: "no_file_received",
        });
      }

      if (file.size < 4000) {
        return res.status(200).json({
          ok: true,
          query: null,
          variants: [],
          confidence: 0,
          identity: null,
          visionIdentity: null,
          reason: "image_too_small",
        });
      }

      console.log("✅ VISION FILE ACCEPTED", {
        rid: req.rid,
        size: file.size,
        mimetype: file.mimetype,
      });

// Phase 4: compute scan embedding
let scanEmbedding = null;
let visualMatches = [];

if (!openai) {
  return res.status(200).json({
    ok: true,
    query: null,
    variants: [],
    confidence: 0,
    identity: null,
    visionIdentity: null,
    reason: "missing_openai_api_key",
  });
}

      if (visionCoolingDown()) {
        console.warn("⚠️ Vision temporarily disabled (cooldown active)");
        return res.status(200).json({
          ok: true,
          query: null,
          variants: [],
          confidence: 0,
          identity: null,
          visionIdentity: null,
          reason: "vision_rate_limited",
        });
      }

      const mode = cleanMode(req.body?.mode);
      const propContext = safeStr(req.body?.propContext, 220);
      const imgHash = sha256(file.buffer);
      const cacheKey = `vision|consensus|${mode}|${propContext}|${imgHash}`;

      let cached = await cacheGet(cacheKey);
      if (!cached) cached = visionCache.get(cacheKey);

      if (cached) {
        return res.status(200).json({ ...cached, cached: true });
      }

      const originalHash = imgHash;
      const storedScan = await persistScanArtifacts(file, originalHash);

      const preparedFile = {
        ...file,
        buffer: storedScan.processedBuffer,
        mimetype: storedScan.processedMime,
        size: storedScan.processedBuffer.length,
      };

      const requestPlan = getResolvedPlan(req);
      const imageQuality = storedScan?.preprocess?.quality || null;

      if (imageQuality?.usable === false && requestPlan !== "internal") {
        return res.status(200).json({
          ok: true,
          query: null,
          variants: [],
          confidence: 0,
          identity: null,
          visionIdentity: null,
          imageHash: originalHash,
          scanAsset: storedScan.asset,
          preprocess: storedScan.preprocess,
          reason: "image_quality_low",
        });
      }

      const visionCostUnits = requestPlan === "free" ? 1 : 2;
      const canSpendVision = await sourceBudget.canUse("vision", {
        plan: requestPlan,
        costUnits: visionCostUnits,
      });

      if (!canSpendVision) {
        return res.status(200).json({
          ok: true,
          query: null,
          variants: [],
          confidence: 0,
          identity: null,
          visionIdentity: null,
          imageHash: originalHash,
          scanAsset: storedScan.asset,
          preprocess: storedScan.preprocess,
          reason: "vision_budget_exhausted",
        });
      }

      await sourceBudget.note("vision", {
        costUnits: visionCostUnits,
      });

      const allowFreshEmbedding =
        requestPlan === "pro" || requestPlan === "internal";

      const embeddingPromise = !allowFreshEmbedding
        ? Promise.resolve({
            scanEmbedding: null,
            visualMatches: [],
          })
        : (async () => {
            const vector = await getOrCreateStoredEmbedding(
              originalHash,
              storedScan.processedBuffer
            );

            let neighbors = [];
            let localNeighbors = [];

            if (vector && typeof nearestVectors === "function") {
              try {
                neighbors = await Promise.resolve(nearestVectors(vector, 8));
              } catch (e) {
                console.warn("vector search failed", e?.message || e);
              }
            }

            if (vector) {
              try {
                localNeighbors = await searchNearestStoredVectors(vector, 8);
              } catch (e) {
                console.warn("local vector search failed", e?.message || e);
              }
            }

            const mergedNeighbors = [];
            const seen = new Set();

            for (const row of [
              ...(Array.isArray(neighbors) ? neighbors : []),
              ...(Array.isArray(localNeighbors) ? localNeighbors : []),
            ]) {
              const key =
                safeStr(
                  row?.imageHash ||
                    row?.id ||
                    row?.query ||
                    row?.metadata?.query ||
                    "",
                  180
                ) || null;

              if (!key || seen.has(key)) continue;
              seen.add(key);
              mergedNeighbors.push(row);
            }

            return {
              scanEmbedding: vector,
              visualMatches: mergedNeighbors,
            };
          })();

      console.log("🧠 CALLING OPENAI VISION", {
        rid: req.rid,
        mode,
        model: VISION_MODEL,
        imageHash: originalHash,
      });

      global.metrics.visionCalls++;

      const result = await withInflight(cacheKey, async () =>
        distributedSingleflight.run(
          `vision:${mode}:${propContext}:${originalHash}`,
          async () =>
            visionConcurrency(async () =>
              withHardTimeout(
                runVisionConsensus({
                  req,
                  file: preparedFile,
                  mode,
                  propContext,
                }),
                12000,
                "vision_consensus_timeout"
              )
            )
        )
      );

      const embeddingResult = await embeddingPromise;
      scanEmbedding = embeddingResult.scanEmbedding;
      visualMatches = embeddingResult.visualMatches;

       const shaped = {
          ok: true,
          query: result?.query || null,
          variants: Array.isArray(result?.variants) ? result.variants : [],
          confidence: clamp01(Number(result?.confidence || 0)),
          identity: {
            ...(result?.identity || {}),
            imageHash: originalHash,
          },
          visionIdentity: {
            ...(result?.identity || {}),
            imageHash: originalHash,
          },
          imageHash: originalHash,
          scanAsset: storedScan.asset,
          preprocess: storedScan.preprocess,
          visualMatches,
          attributeCertainty: result?.attributeCertainty
            ? buildAttributeCertaintyPayload(result.attributeCertainty)
            : null,
          authenticityFlags: Array.isArray(result?.authenticityFlags) ? result.authenticityFlags : [],
          conditionFlags:    Array.isArray(result?.conditionFlags)    ? result.conditionFlags    : [],
          debug: result?.debug || null,
        };

        // ── Serial parser (non-LLM, from visibleText) ──────────────────────────
        const visibleTextArray = Array.isArray(shaped.identity?.visibleText)
          ? shaped.identity.visibleText
          : [];
        let serialResult = null;
        if (visibleTextArray.length) {
          try {
            serialResult = await parseSerialFromText(visibleTextArray, redis);
            if (serialResult?.ok) {
              shaped.serialResult = serialResult;
            }
          } catch (e) {
            console.warn("serial_parser_text_error", e?.message || e);
          }
        }

        // ── Condition grader ───────────────────────────────────────────────────
        try {
          const conditionGrade = gradeCondition({
            visionResult:      shaped,
            category:          shaped.identity?.category || null,
            overallConfidence: shaped.confidence,
          });
          shaped.conditionGrade = conditionGrade;
        } catch (e) {
          console.warn("condition_grader_error", e?.message || e);
        }

        // ── Resale graph ingest (background) ───────────────────────────────────
        if (shaped.identity && shaped.query) {
          enqueueBackgroundJob(
            "graph_ingest",
            { imageHash: originalHash, query: shaped.query },
            async () => {
              try {
                await ingestScanToGraph(redis, {
                  identity:    shaped.identity,
                  marketItems: [],
                  serialResult: serialResult || null,
                });
              } catch (e) {
                console.warn("graph_ingest_error", e?.message || e);
              }
              return { ok: true };
            }
          );
        }

        // ── Counterfactual scan (pro/internal only, background) ─────────────────
        if (
          (requestPlan === "pro" || requestPlan === "internal") &&
          shaped.query &&
          process.env.COUNTERFACTUAL_ENABLED !== "false"
        ) {
          const base64ForCF    = preparedFile.buffer.toString("base64");
          const dataUrlForCF   = `data:${preparedFile.mimetype || "image/jpeg"};base64,${base64ForCF}`;
          enqueueBackgroundJob(
            "counterfactual_scan",
            { imageHash: originalHash, query: shaped.query },
            async () => {
              try {
                const cfResult = await runCounterfactualScan({
                  dataUrl:       dataUrlForCF,
                  mode,
                  propContext,
                  rid:           req.rid,
                  primaryResult: result,
                  marketItems:   [],
                  plan:          requestPlan,
                  runVisionPassFn: runVisionPass,
                });
                if (cfResult) {
                  // Cache counterfactual result separately, frontend can poll /vision/counterfactual/:hash
                  await cacheSet(
                    `counterfactual:${originalHash}`,
                    cfResult,
                    3600
                  );
                }
              } catch (e) {
                console.warn("counterfactual_error", e?.message || e);
              }
              return { ok: true };
            }
          );
        }



      if (scanEmbedding && shaped.query) {

        enqueueBackgroundJob(
          "store_scan_vector",
          {
            imageHash: originalHash,
            query: shaped.query,
          },
          async () => {
            storeVector(shaped.query, scanEmbedding);

            await upsertScanVector({
              imageHash: originalHash,
              query: shaped.query,
              vector: scanEmbedding,
              metadata: {
                imageHash: originalHash,
                identity: shaped.identity || null,
                preprocess: shaped.preprocess || null,
              },
            });

            return {
              ok: true,
              imageHash: originalHash,
              query: shaped.query,
            };
          }
        );
      }

        // ── Barcode Intelligence (Feature 63) ─────────────────────────────────
        try {
          const barcodeResult = await buildBarcodeIntelligencePayload({
            visibleText: Array.isArray(shaped.identity?.visibleText) ? shaped.identity.visibleText : [],
            barcode:     req.body?.barcode || null,
            redis,
          });
          shaped.barcodeIntel = barcodeResult;
          // If barcode found a product and we have no query, use barcode query
          if (barcodeResult?.found && barcodeResult.query && !shaped.query) {
            shaped.query = barcodeResult.query;
          }
          // Upgrade identity with barcode brand/model if vision was uncertain
          if (barcodeResult?.found && shaped.confidence < 0.6) {
            if (barcodeResult.brand && !shaped.identity?.brand) shaped.identity.brand = barcodeResult.brand;
            if (barcodeResult.title && !shaped.identity?.model) shaped.identity.model = barcodeResult.title;
          }
        } catch (e) { console.warn("barcode_intel_error", e?.message || e); }

        // ── Box Tag Extraction (Feature 65) ────────────────────────────────────
        try {
          const boxTagResult = buildBoxTagPayload({
            visibleText: Array.isArray(shaped.identity?.visibleText) ? shaped.identity.visibleText : [],
            identity:    shaped.identity || {},
            query:       shaped.query,
          });
          shaped.boxTag = boxTagResult;
          // Upgrade query with SKU/colorway info from box tag
          if (boxTagResult?.hasBoxData && boxTagResult.enhancedQuery) {
            shaped.identity.exactQuery = boxTagResult.enhancedQuery;
            if (!shaped.identity.sizeHint && boxTagResult.boxTag?.size) {
              shaped.identity.sizeHint = boxTagResult.boxTag.size;
            }
          }
        } catch (e) { console.warn("box_tag_error", e?.message || e); }

        // ── Logo Confidence Scoring (Feature 67) ──────────────────────────────
        try {
          const logoConf = buildLogoConfidencePayload(shaped);
          shaped.logoConfidence = logoConf?.logoConfidence || null;
          // If logo confidence says brand is NOT trusted, lower overall confidence
          if (logoConf?.logoConfidence?.trusted === false && shaped.confidence > 0.6) {
            shaped.confidence = Math.max(0.35, shaped.confidence - 0.20);
            shaped.attributeCertainty = {
              ...(shaped.attributeCertainty || {}),
              brand: Math.min(shaped.attributeCertainty?.brand ?? 0.5, 0.5),
            };
          }
        } catch (e) { console.warn("logo_confidence_error", e?.message || e); }

        // ── Seller Jargon Normalization (Feature 66) ──────────────────────────
        try {
          if (shaped.query) {
            const jargonResult = normalizeSellerJargon(shaped.query);
            if (jargonResult.changed && jargonResult.normalized) {
              shaped.normalizedQuery = jargonResult.normalized;
              shaped.jargonExtracted = jargonResult.extracted;
            }
          }
        } catch (e) { console.warn("jargon_normalizer_error", e?.message || e); }

        // ── Scan replay recording (background) ────────────────────────────────
        if (process.env.SCAN_REPLAY_ENABLED !== "false") {
          queueScanReplayRecord({
            scanId:            originalHash,
            userId:            getResolvedUserId(req) || null,
            imageHash:         originalHash,
            query:             shaped.query,
            visionResult:      { confidence: shaped.confidence, identity: shaped.identity },
            serialResult:      shaped.serialResult  || null,
            conditionGrade:    shaped.conditionGrade || null,
            attributeCertainty:result?.attributeCertainty || null,
            marketItems:       [],
            mode,
            plan:              requestPlan,
          });
        }

        visionCache.set(cacheKey, shaped);
        await cacheSet(cacheKey, shaped, 86400);

        return res.status(200).json(shaped);
    } catch (err) {
      if (err?.status === 429 || String(err?.message || "").includes("429")) {
        triggerVisionCooldown(60);
      }

      const name = err?.name || "error";
      const reason = name === "AbortError" ? "vision_timeout" : "vision_exception";

      incrementMetric("vision_failure_total", {
        reason,
      });

      await emitOpsAlert(
        "vision_failure",
        {
          rid: req.rid,
          reason,
          message: err?.message || String(err),
          route: req.originalUrl,
        },
        {
          severity: reason === "vision_timeout" ? "warn" : "error",
          cooldownMs: 60_000,
        }
      );

      console.warn("❌ VISION ERROR:", reason, err?.message || err, err?.stack?.split("\n").slice(1,4).join(" | "));

      return res.status(200).json({
        ok: true,
        query: null,
        variants: [],
        confidence: 0,
        identity: null,
        visionIdentity: null,
        reason,
      });
    }
  }
);

// -------------------- VISION ENRICH --------------------
app.post("/vision/enrich", async (req, res) => {
  try {
    if (!openai) return res.status(200).json({ ok: false, reason: "missing_openai_api_key" });


    const rawQuery = safeStr(req.body?.query, 220);
    const query = normalizeQuery(rawQuery);
    const mode = cleanMode(req.body?.mode);
    const context = safeStr(req.body?.context, 220);

    if (!query) return res.status(200).json({ ok: false, reason: "missing_query" });

    const cacheKey = `enrich|${mode}|${context}|${query}`;
    const cached = visionCache.get(cacheKey);
    if (cached) return res.status(200).json({ ...cached, cached: true });

    const enrichPrompt = `
You are Evan AI — world-class resale intelligence enrichment engine.
You are given a marketplace search query and must return the richest, most accurate resale-relevant structured data possible.

Input query: "${query}"
Mode: "${mode}"
Context: "${context || "none"}"

Your output powers a resale intelligence app used by buyers and flippers. Be a domain expert:

COLLECTOR block — identify the item's collector and resale significance:
- summary: 1-2 sentence expert description (brand, model, era, why it matters to resellers)
- era: decade or specific year range if known (e.g. "2019-2022", "1990s", "2015 retro")
- maker: exact brand/manufacturer name (canonical spelling, e.g. "Louis Vuitton", "Nike", "Rolex")
- model: exact model name as used in marketplace listings (e.g. "Air Jordan 1 Retro High OG", "Neverfull MM", "Submariner Date")
- tells: array of 3-6 authenticity visual tells or collector knowledge facts (e.g. "heel tab should read NIKE AIR", "LV date code format: 2 letters + 4 digits", "Rolex cyclops magnifies date 2.5x")

MATERIALS block — signals: array of material/construction signals that affect value (e.g. "full-grain leather", "canvas upper", "YKK zipper", "sapphire crystal", "titanium case")

ALTERNATIVES block — queries: array of 4-8 alternative marketplace search queries covering:
- narrower searches (add colorway, size, year)
- broader searches (remove specifics)
- alternate names/spellings used by sellers
- related collab or special editions that fetch similar prices

LOCAL block — keywords: 4-6 search terms optimized for local marketplace apps (OfferUp, Facebook Marketplace) — simpler, broader, common vernacular

PARTS block — keywords: 4-6 keywords for parts/accessories/replacement searches (e.g. "Air Jordan 1 replacement laces", "Rolex jubilee bracelet", "Louis Vuitton Neverfull insert")

Be specific. Be accurate. This data is used to find real resale prices — wrong data = financial harm.
`.trim();

    const timeout = withTimeout(TEXT_TIMEOUT_MS);

    const response = await withModelServing(
      "vision_enrich",
      () =>
        openai.responses.create(
          {
            model: ENRICH_MODEL,
            temperature: 0.2,
            max_output_tokens: 800,

            prompt_cache_key: "evan-ai-enrich-v5",
            prompt_cache_retention: "24h",

            text: {
              format: {
                type: "json_schema",
                name: "evan_ai_enrich_result",
                strict: true,
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["ok", "collector", "materials", "alternatives", "local", "parts"],
                  properties: {
                    ok: { type: "boolean" },
                    collector: {
                      type: "object",
                      additionalProperties: false,
                      required: ["summary", "era", "maker", "model", "tells"],
                      properties: {
                        summary: { anyOf: [{ type: "string" }, { type: "null" }] },
                        era: { anyOf: [{ type: "string" }, { type: "null" }] },
                        maker: { anyOf: [{ type: "string" }, { type: "null" }] },
                        model: { anyOf: [{ type: "string" }, { type: "null" }] },
                        tells: { type: "array", items: { type: "string" } },
                      },
                    },
                    materials: {
                      type: "object",
                      additionalProperties: false,
                      required: ["signals"],
                      properties: {
                        signals: { type: "array", items: { type: "string" } },
                      },
                    },
                    alternatives: {
                      type: "object",
                      additionalProperties: false,
                      required: ["queries"],
                      properties: {
                        queries: { type: "array", items: { type: "string" } },
                      },
                    },
                    local: {
                      type: "object",
                      additionalProperties: false,
                      required: ["keywords"],
                      properties: {
                        keywords: { type: "array", items: { type: "string" } },
                      },
                    },
                    parts: {
                      type: "object",
                      additionalProperties: false,
                      required: ["keywords"],
                      properties: {
                        keywords: { type: "array", items: { type: "string" } },
                      },
                    },
                  },
                },
              },
            },

            input: [{ role: "user", content: [{ type: "input_text", text: enrichPrompt }] }],
            metadata: { rid: req.rid || "", mode: mode || "item" },
          },
          { signal: timeout.signal }
        ),
      {
        provider: "openai",
        model: ENRICH_MODEL,
        maxConsecutiveFailures: 4,
        circuitMs: 45_000,
      }
    );
    timeout.cancel();

    let parsed = null;
    
    try {
      parsed = JSON.parse(response.output_text || "{}");
    } catch {
      parsed = null;
    }

    if (!parsed || parsed.ok !== true) {
      return res.status(200).json({ ok: false, reason: "parse_failed" });
    }

    visionCache.set(cacheKey, parsed);
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(200).json({ ok: false, reason: "enrich_exception" });
  }
});




// -------------------- SERP: google shopping --------------------
async function serpShopping(query, opts = {}) {
  const { bypassCooldown = false, softFail = false } = opts || {};

  if (!SERPAPI_KEY) return [];
  if (process.env.DISABLE_SERP === "true") return [];
  if (!bypassCooldown && isSourceCoolingDown("serpapi")) {
  console.warn("⚠️ SerpAPI cooling — allowing fallback queries");
}


  const startedAt = Date.now();

  const params = new URLSearchParams({
    engine: "google_shopping",
    q: query,
    hl: "en",
    gl: "us",
    api_key: SERPAPI_KEY,
  });

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12000);

  try {
    const url = `https://serpapi.com/search.json?${params.toString()}`;
    const r = await fetch(url, { signal: controller.signal });

      if (!r.ok) {
        if (r.status === 429) {
          if (!softFail) {
            markSourceFailure("serpapi", "http_429");

            const h = getSourceHealth("serpapi");
            h.cooldownUntil = Math.max(
              Number(h.cooldownUntil || 0),
              Date.now() + 45 * 1000
            );
          }

          console.warn(
            "⚠️ SerpAPI 429.",
            softFail ? "Skipping secondary query." : "Cooling down source for 45s.",
            "query=",
            query,
            "softFail=",
            softFail
          );
          return [];
        }

      if (!softFail) {
        markSourceFailure("serpapi", `http_${r.status}`);
      }

      console.warn(
        "⚠️ SerpAPI request failed:",
        r.status,
        "query=",
        query,
        "softFail=",
        softFail
      );
      return [];
    }

    const data = await r.json();

    const raw = [
      ...(Array.isArray(data.shopping_results) ? data.shopping_results : []),
      ...(Array.isArray(data.inline_shopping_results)
        ? data.inline_shopping_results
        : []),
    ];

    console.log("🛒 SERP RAW COUNT", {
      query,
      raw: raw.length,
      hasShoppingResults: Array.isArray(data.shopping_results),
      hasInlineShoppingResults: Array.isArray(data.inline_shopping_results),
    });

    let items = raw
      .map((it, idx) => {
        const normalized = normalizeItem({
          ...it,
          link:
            it.link ||
            it.product_link ||
            it.product_page_url ||
            it.google_product_link ||
            it.google_shopping_product_link ||
            it.offer_page_url ||
            it.offer_link ||
            it.merchant_link ||
            it.product_url ||
            it.url ||
            it.serpapi_link ||
            null,
        });

        const fallbackLink =
          normalized.link ||
          normalized.googleProductLink ||
          normalized.merchantLink ||
          it.link ||
          it.product_link ||
          it.product_page_url ||
          it.google_product_link ||
          it.google_shopping_product_link ||
          it.offer_page_url ||
          it.offer_link ||
          it.merchant_link ||
          it.product_url ||
          it.url ||
          it.serpapi_link ||
          null;

        return {
          ...normalized,
          link: fallbackLink,
          url: fallbackLink,
          buyLink: fallbackLink,
          linkVerified: Boolean(fallbackLink),
          source:
            normalized.source ||
            it.source ||
            it.store_name ||
            it.store ||
            it.seller ||
            it.merchant_name ||
            "google shopping",
          __fromMarketSearch: true,
          __serverRank: idx + 1,
        };
      })
      .filter((x) => x.title)
      .filter(
        (x) => Number.isFinite(x.totalPrice) || Number.isFinite(x.price)
      );

    items = dedupeSmart(items);

    console.log("🛒 SERP NORMALIZED COUNT", {
      query,
      raw: raw.length,
      kept: items.length,
      top: items.slice(0, 3).map((x) => ({
        title: x.title,
        price: x.totalPrice ?? x.price ?? null,
        link: x.link || null,
        source: x.source || null,
      })),
    });

    markSourceSuccess("serpapi", Date.now() - startedAt);

    // IMPORTANT:
    // keep serpShopping relaxed.
    // mergeCheapestSources already does the smarter filtering/ranking later.
    return items.slice(0, 60);
  } catch (err) {
    if (!softFail) {
      markSourceFailure(
        "serpapi",
        err?.name === "AbortError" ? "timeout" : "exception"
      );
    }

    console.warn(
      "⚠️ SerpAPI search error:",
      err?.name || "error",
      err?.message || err,
      "query=",
      query,
      "softFail=",
      softFail
    );

    return [];
  } finally {
    clearTimeout(t);
  }
}

// -------------------- ETSY ROUTE --------------------
app.get("/search/etsy", async (req, res) => {
  const rawQuery = safeStr(req.query?.q, 220);
  const query = normalizeQuery(rawQuery);

  if (!query || !hasEtsyApi()) {
    return res.status(200).json([]);
  }

  const cacheKey = `etsy_priority|${query}`;
  const cached = SERP_CACHE.get(cacheKey);
  if (cached) return res.status(200).json(cached);

  try {
    const items = await withInflight(cacheKey, async () => {
      const variants = buildEtsyVariants(query);
      let merged = [];

      for (const q of variants) {
        const rows = await etsySearch(q);
        if (rows?.length) merged.push(...rows);
      }

      merged = dedupeSmart(merged);
      merged = filterRelevantListings(query, merged);
      merged = trimPriceOutliers(merged);
      merged = intuitionFilter(merged);
      merged = sortByAbsoluteCheapest(merged).slice(0, 60);

      return merged;
    });

    SERP_CACHE.set(cacheKey, items);
    return res.status(200).json(items);
  } catch {
    const fallback = SERP_CACHE.get(cacheKey);
    return res.status(200).json(fallback || []);
  }
});

app.get("/search/serp", async (req, res) => {
  const rawQuery = safeStr(req.query?.q, 220);
  const query = sanitizeMarketplaceQuery(rawQuery);

  if (!query) {
    return res.status(200).json([]);
  }

  const cacheKey = `search_any|${query}`;
  const cached = SERP_CACHE.get(cacheKey);
  if (cached) return res.status(200).json(cached);

  try {
    const items = await withInflight(cacheKey, async () => {
      let out = await mergeCheapestSources(query, [], null);
      out = sortByAbsoluteCheapest(out, query).slice(0, 60);
      return out;
    });

    SERP_CACHE.set(cacheKey, items);
    return res.status(200).json(items);
  } catch {
    const fallback = SERP_CACHE.get(cacheKey);
    return res.status(200).json(fallback || []);
  }
});

// Ebay MVP (site filter)
app.get("/search/ebay", async (req, res) => {
  const rawQuery = safeStr(req.query?.q, 220);
  const query = sanitizeMarketplaceQuery(rawQuery);

  if (!query) return res.status(200).json([]);

  const cacheKey = `ebay_cheapest|${query}`;
  const cached = SERP_CACHE.get(cacheKey);
  if (cached) return res.status(200).json(cached);

  try {
    const items = await withInflight(cacheKey, async () => {
      let out = await ebayAdapterSearch(query);
      out = filterRelevantListings(query, out);
      out = trimPriceOutliers(out);
      out = intuitionFilter(out);
      out = sortByAbsoluteCheapest(out, query).slice(0, 60);
      return out;
    });

    SERP_CACHE.set(cacheKey, items);
    return res.status(200).json(items);
  } catch {
    return res.status(200).json([]);
  }
});

async function etsySearch(query) {
  if (!hasEtsyApi()) return [];
  if (isSourceCoolingDown("etsy")) return [];

  const q = sanitizeMarketplaceQuery(query);
  if (!q) return [];

  const startedAt = Date.now();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 7000);

  try {
    const url =
      "https://api.etsy.com/v3/application/listings/active?" +
      new URLSearchParams({
        keywords: q,
        limit: "24",
      });

    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        "x-api-key": buildEtsyApiKeyHeader(),
        Authorization: `Bearer ${ETSY_OAUTH_TOKEN}`,
        Accept: "application/json",
      },
    });

    if (r.status === 429) {
      ETSY_COOLDOWN_UNTIL = Date.now() + 90 * 1000;
      markSourceFailure("etsy", "http_429");
      console.warn("⚠️ Etsy rate limited. Cooling down for 90s.");
      return [];
    }

    if (r.status === 403) {
      ETSY_COOLDOWN_UNTIL = Date.now() + 10 * 60 * 1000;
      markSourceFailure("etsy", "http_403");
      console.warn("⚠️ Etsy 403. Key/app access rejected. Disabling Etsy for 10m.");
      return [];
    }

    if (!r.ok) {
      markSourceFailure("etsy", `http_${r.status}`);
      console.warn("⚠️ Etsy request failed:", r.status);
      return [];
    }

    const data = await r.json().catch(() => ({}));

    const raw = (Array.isArray(data?.results) ? data.results : []).map((x) => {
      const amount = Number(x?.price?.amount ?? x?.price_amount ?? 0);
      const divisor = Number(x?.price?.divisor ?? 100) || 100;

      return {
        title: x?.title || null,
        extracted_price: amount > 0 ? amount / divisor : null,
        source: "etsy",
        link: x?.url || null,
        thumbnail:
          x?.images?.[0]?.url_fullxfull ||
          x?.images?.[0]?.url_570xN ||
          null,
        rating: x?.shop?.review_average ?? null,
        reviews: x?.shop?.review_count ?? null,
      };
    });

    let items = raw
      .map(normalizeItem)
      .filter((x) => x.title && x.link);

    items = items.filter((it) => !isBadListing(it.title, q));
    items = trimPriceOutliers(items);
    items = dedupeSmart(items);
    items = sortByAbsoluteCheapest(items, q);

    markSourceSuccess("etsy", Date.now() - startedAt);
    return items.slice(0, 60);
  } catch (err) {
    markSourceFailure(
      "etsy",
      err?.name === "AbortError" ? "timeout" : "exception"
    );
    console.warn("⚠️ Etsy search error:", err?.message || err);
    return [];
  } finally {
    clearTimeout(t);
  }
}

async function walmartCatalogSearch(query = "") {
  const q = sanitizeMarketplaceQuery(query);
  if (!q || !hasWalmartApi()) return [];

  const token = await getWalmartAccessToken();
  if (!token) return [];

  const startedAt = Date.now();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 9000);

  try {
    const headers = {
      Accept: "application/json",
      "WM_SEC.ACCESS_TOKEN": token,
      "WM_QOS.CORRELATION_ID": newCorrelationId(),
      "WM_SVC.NAME": "Evan AI",
    };

    if (WALMART_CHANNEL_TYPE) {
      headers["WM_CONSUMER.CHANNEL.TYPE"] = WALMART_CHANNEL_TYPE;
    }

    if (WALMART_PARTNER_ID) {
      headers["WM_PARTNER.ID"] = WALMART_PARTNER_ID;
    }

    if (WALMART_TENANT_ID) {
      headers["WM_TENANT_ID"] = WALMART_TENANT_ID;
    }

    const url =
      `https://marketplace.walmartapis.com/v3/items/walmart/search?` +
      new URLSearchParams({
        query: q,
        limit: "24",
      }).toString();

    const r = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers,
    });

    if (!r.ok) {
      markSourceFailure("walmart", `http_${r.status}`);
      console.warn("⚠️ Walmart catalog search failed:", r.status, "query=", q);
      return [];
    }

    const data = await r.json().catch(() => ({}));

    const raw =
      (Array.isArray(data?.items) && data.items) ||
      (Array.isArray(data?.ItemResponse?.items) && data.ItemResponse.items) ||
      (Array.isArray(data?.payload?.items) && data.payload.items) ||
      [];

    let items = raw
      .map((it) =>
        normalizeItem({
          title: it?.productName || it?.name || it?.title || null,
          extracted_price:
            Number(it?.price?.amount ?? NaN) ||
            Number(it?.priceInfo?.currentPrice?.price ?? NaN) ||
            Number(it?.price ?? NaN) ||
            Number(it?.salePrice ?? NaN),
          source: "walmart",
          link:
            it?.productPageUrl ||
            it?.productUrl ||
            (it?.itemId ? `https://www.walmart.com/ip/${it.itemId}` : null),
          thumbnail:
            it?.images?.[0]?.url ||
            it?.imageInfo?.thumbnailUrl ||
            it?.primaryImageUrl ||
            it?.image ||
            null,
          rating:
            typeof it?.averageRating === "number"
              ? it.averageRating
              : typeof it?.customerRating === "number"
              ? it.customerRating
              : null,
          reviews:
            typeof it?.numberOfReviews === "number"
              ? it.numberOfReviews
              : typeof it?.reviewCount === "number"
              ? it.reviewCount
              : null,
        })
      )
      .filter((it) => it?.title)
      .filter((it) => Number.isFinite(it?.totalPrice) || Number.isFinite(it?.price));

    items = items.filter((it) => !isBadListing(it.title, q));
    items = trimPriceOutliers(items);
    items = dedupeSmart(items);
    items = sortByAbsoluteCheapest(items, q);

    markSourceSuccess("walmart", Date.now() - startedAt);
    return items.slice(0, 60);
  } catch (err) {
    markSourceFailure(
      "walmart",
      err?.name === "AbortError" ? "timeout" : "exception"
    );
    console.warn("⚠️ Walmart search error:", err?.message || err);
    return [];
  } finally {
    clearTimeout(t);
  }
}

async function bestBuySearch(query = "") {
  const q = sanitizeMarketplaceQuery(query);
  if (!q || !hasBestBuyApi()) return [];

  const startedAt = Date.now();
  const words = titleTokens(q).slice(0, 6);
  if (!words.length) return [];

  try {
    const expr = words.map((w) => `search=${encodeURIComponent(w)}`).join("&");

    const url =
      `https://api.bestbuy.com/v1/products(${expr})` +
      `?format=json` +
      `&pageSize=24` +
      `&show=sku,name,salePrice,url,image,thumbnailImage,largeFrontImage,customerReviewAverage,customerReviewCount,condition,manufacturer` +
      `&apiKey=${encodeURIComponent(BESTBUY_API_KEY)}`;

    const r = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!r.ok) {
      markSourceFailure("bestbuy", `http_${r.status}`);
      console.warn("⚠️ Best Buy search failed:", r.status, "query=", q);
      return [];
    }

    const data = await r.json().catch(() => ({}));
    const raw = Array.isArray(data?.products) ? data.products : [];

    let items = raw
      .map((it) =>
        normalizeItem({
          title: it?.name || null,
          extracted_price: Number(it?.salePrice ?? NaN),
          source: "best buy",
          link:
            it?.url ||
            (it?.sku ? `https://www.bestbuy.com/site/${it.sku}.p` : null),
          thumbnail:
            it?.image || it?.largeFrontImage || it?.thumbnailImage || null,
          rating:
            typeof it?.customerReviewAverage === "number"
              ? it.customerReviewAverage
              : null,
          reviews:
            typeof it?.customerReviewCount === "number"
              ? it.customerReviewCount
              : null,
        })
      )
      .filter((it) => it?.title)
      .filter((it) => Number.isFinite(it?.totalPrice) || Number.isFinite(it?.price));

    items = items.filter((it) => !isBadListing(it.title, q));
    items = trimPriceOutliers(items);
    items = dedupeSmart(items);
    items = sortByAbsoluteCheapest(items, q);

    markSourceSuccess("bestbuy", Date.now() - startedAt);
    return items.slice(0, 60);
  } catch (err) {
    markSourceFailure("bestbuy", "exception");
    console.warn("⚠️ Best Buy search error:", err?.message || err);
    return [];
  }
}

// keep the old name alive so any legacy callers do not break
async function serpEbaySearch(query) {
  return await searchEbayBrowse(query);
}

async function buildMarketSearchResponsePayload({
  query,
  finalQuery = null,
  searchedQueries = [],
  variants = [],
  items = [],
  scannedPrice = null,
  visionConfidence = 0.5,
  category = null,
  visionIdentity = null,
  authenticityFlags = [],
  conditionFlags = [],
  retrievalMeta = null,
  persistSnapshot = false,
} = {}) {
  const baseQuery = normalizeQuery(query || "");
  const sourceItems = Array.isArray(items) ? items.filter(Boolean) : [];

  const resolvedFinalQuery = normalizeQuery(
    finalQuery ||
      (sourceItems.length ? promoteQueryFromMarket(baseQuery, sourceItems) : baseQuery)
  );

  const activeQuery = resolvedFinalQuery || baseQuery;

  const { uiItems, intelligence } = await buildFinalUiItemsWithIntelligence(
    activeQuery,
    sourceItems,
    {
      scannedPrice,
      visionConfidence,
    }
  );

  const soldPool = uiItems.filter(
    (i) => i?.sold === true || String(i?.status || "").toLowerCase() === "sold"
  );

  const soldStats = soldPool.length ? computeSoldCompStats(soldPool) : null;
  const sellThrough = soldPool.length
    ? estimateSellThrough(uiItems, soldPool)
    : null;
  const exitPrice = soldPool.length ? predictExitPrice(soldStats) : null;
  const moatMode = soldPool.length ? "real_sold" : "live_proxy";

  const aesthetic = classifyAesthetic(activeQuery);
  const demand = demandRadar(uiItems);

  const consensus = buildMarketConsensus(uiItems, scannedPrice, visionConfidence);

  const prediction = buildFlipPrediction({
    items: uiItems,
    scannedPrice,
    visionConfidence,
    category,
  });

  prediction.exitPrice = exitPrice;
  prediction.sellThrough = sellThrough;
  prediction.aesthetic = aesthetic;
  prediction.demand = demand;
  prediction.moatMode = moatMode;
  prediction.soldStats = soldStats;

  const coach = buildResaleCoach({
    prediction,
    consensus,
    scannedPrice,
    finalQuery: activeQuery,
  });

  const pulse = recordPulse(activeQuery);
  const best = uiItems[0] || null;
  const bestPrice = finitePrice(best?.totalPrice ?? best?.price);

  const historical =
    getHistoricalStats(activeQuery) ||
    productStats(activeQuery) ||
    null;

  const marketPulseScore = marketHeat(activeQuery);

  const dealHunter = buildDealHunterPayload(activeQuery, uiItems, {
    scannedPrice,
    historicalAvg: historical?.avg ?? null,
    marketAvg: consensus?.avgPrice ?? historical?.avg ?? null,
    marketHeat: marketPulseScore,
  });

  const sellSide = buildSellSideEstimate(activeQuery, uiItems, {
    scannedPrice,
    marketHeat: marketPulseScore,
  });

    const authenticity = authSummary(uiItems.slice(0, 8));

    // ── Liquidity score ────────────────────────────────────────────────────────
    const liquidityResult = computeLiquidityScore({
      category,
      marketItems:     uiItems,
      visionCondition: visionIdentity?.condition || "",
      priceMedian:     finitePrice(consensus?.medianPrice ?? prediction?.medianPrice),
      graphData:       null, // populated over time via resale graph
    });

    // ── Exit strategy ─────────────────────────────────────────────────────────
    const exitStrategy = buildExitStrategy({
      identity:       visionIdentity || {},
      liquidityResult,
      marketItems:    uiItems,
      consensus,
      prediction,
      scannedPrice,
    });

    // ── Substitute intelligence ────────────────────────────────────────────────
    const substituteIntel = buildSubstituteIntelPayload({
      identity:     visionIdentity || {},
      uiItems,
      scannedPrice,
      category,
    });

    // ── Cheaper alternative / don't buy this ──────────────────────────────────
    const dontBuyThis = buildDontBuyThisPayload({
      identity:       visionIdentity || {},
      scannedPrice,
      uiItems,
      category,
      substituteIntel,
    });

    // ── Arbitrage intelligence ────────────────────────────────────────────────
    const arbitrageIntel = buildArbitrageIntelPayload({
      uiItems,
      scannedPrice,
      category,
      consensus,
    });

    // ── Deal comparator ───────────────────────────────────────────────────────
    const dealComparator = buildDealComparatorPayload({
      scannedPrice,
      uiItems,
      consensus,
      category,
      identity: visionIdentity || null,
    });

    // ── Trend intelligence ────────────────────────────────────────────────────
    const trendIntel = buildTrendIntelPayload({
      identity:    visionIdentity || {},
      category,
      scannedPrice,
      uiItems,
      consensus,
    });

    // ── Deep authenticity intelligence ────────────────────────────────────────
    const authenticityIntel = buildAuthenticityIntelPayload({
      identity:          visionIdentity || {},
      scannedPrice,
      category,
      visionConfidence:  visionConfidence ?? 0.5,
      existingAuthScore: null,
      authenticityFlags: Array.isArray(authenticityFlags) ? authenticityFlags : [],
    });

    // ── Resale optimizer ──────────────────────────────────────────────────────
    const resaleOptimizer = buildResaleOptimizerPayload({
      identity:      visionIdentity || {},
      category,
      scannedPrice,
      medianMarket:  finitePrice(consensus?.medianPrice ?? prediction?.medianPrice),
      conditionLabel:visionIdentity?.condition || "",
      liquidityTier: liquidityResult?.tier || "moderate",
      isLuxury:      ["luxury"].includes(liquidityResult?.brandTier) || false,
    });

    // ── Bundle intelligence ───────────────────────────────────────────────────
    const bundleIntel = buildBundleIntelPayload({
      identity:    visionIdentity || {},
      category,
      scannedPrice,
      medianMarket:finitePrice(consensus?.medianPrice ?? prediction?.medianPrice),
    });

    // ── Price history intelligence ─────────────────────────────────────────────
    const priceHistoryIntel = buildPriceHistoryIntelPayload({
      scannedPrice,
      uiItems,
      consensus,
      category,
    });

    // ── Condition pricing adjuster ────────────────────────────────────────────
    const conditionPricing = buildConditionPricingPayload({
      listingPrice:   scannedPrice,
      conditionLabel: visionIdentity?.condition || "",
      newMarketPrice: finitePrice(consensus?.medianPrice ?? prediction?.medianPrice),
      medianMarket:   finitePrice(consensus?.medianPrice ?? prediction?.medianPrice),
      category,
    });

    // ── Demand signal engine ──────────────────────────────────────────────────
    const demandSignals = buildDemandSignalPayload({
      uiItems,
      category,
    });

    // ── Negotiation intelligence ──────────────────────────────────────────────
    const negotiationIntel = buildNegotiationIntelPayload({
      listingPrice:     scannedPrice,
      marketMedian:     finitePrice(consensus?.medianPrice ?? prediction?.medianPrice),
      dealVerdict:      dealComparator?.verdict?.verdict || "fair",
      identity:         visionIdentity || {},
      conditionAdjusted:conditionPricing?.adjusted || null,
    });

    // ── Unified purchase risk score ────────────────────────────────────────────
    const riskScore = buildRiskScorePayload({
      authenticityIntel,
      conditionPricing,
      dealComparator,
      demandSignals,
      trendIntel,
      scannedPrice,
    });

    // ── Category-specific deep intel ──────────────────────────────────────────
    const categoryIntel = buildCategorySpecificIntel({
      identity:    visionIdentity || {},
      category,
      uiItems,
      visibleText: visionIdentity?.visibleText || [],
    });

    // ── Smart alert engine ─────────────────────────────────────────────────────
    const smartAlerts = buildSmartAlertPayload({
      dealComparator,
      authenticityIntel,
      arbitrageIntel,
      trendIntel,
      demandSignals,
      conditionPricing,
      substituteIntel,
      priceHistoryIntel,
      riskScore,
      identity:    visionIdentity || {},
      scannedPrice,
    });

    // ── Profit calculator ─────────────────────────────────────────────────────
    const profitCalc = buildProfitCalculatorPayload({
      scannedPrice,
      medianMarket: finitePrice(consensus?.medianPrice ?? prediction?.medianPrice),
      category,
    });

    // ── Image context intelligence ────────────────────────────────────────────
    const imageContext = buildImageContextPayload({
      visibleText:      visionIdentity?.visibleText  || [],
      styleWords:       visionIdentity?.styleWords   || [],
      visionResult:     visionIdentity               || null,
      visionConfidence: visionConfidence             ?? 0.5,
    });

    // ── Evan Summary — master verdict ─────────────────────────────────────────
    // ── DNA match engine ──────────────────────────────────────────────────────
    const dnaMatch = buildDNAMatchPayload({
      primaryItem:  visionIdentity || {},
      primaryPrice: scannedPrice,
      candidates:   uiItems,
      scannedPrice,
    });

    // ── Price anomaly detection ───────────────────────────────────────────────
    const priceAnomaly = buildPriceAnomalyPayload({
      scannedPrice,
      uiItems,
    });

    // ── Value depreciation curve ──────────────────────────────────────────────
    const depreciationCurve = buildValueDepreciationCurve({
      identity:      visionIdentity || {},
      category,
      currentPrice:  scannedPrice,
      conditionLabel:visionIdentity?.condition || "",
      medianMarket:  finitePrice(consensus?.medianPrice ?? prediction?.medianPrice),
    });

    // ── Query arbitrage engine ────────────────────────────────────────────────
    const queryArbitrage = buildQueryArbitragePayload({
      identity: visionIdentity || {},
      category,
      uiItems,
    });

    // ── Size arbitrage engine ─────────────────────────────────────────────────
    const sizeArbitrage = buildSizeArbitragePayload({
      identity: visionIdentity || {},
      uiItems,
      size: visionIdentity?.size || "",
    });

    // ── Colorway substitute engine ────────────────────────────────────────────
    const colorwaySubstitutes = buildColorwaySubstitutePayload({
      identity: visionIdentity || {},
      scannedPrice: finitePrice(scannedPrice),
      uiItems,
    });

    // ── Release calendar intelligence ─────────────────────────────────────────
    const releaseCalendar = buildReleaseCalendarPayload({
      identity: visionIdentity || {},
      scannedPrice: finitePrice(scannedPrice),
      medianMarket: finitePrice(consensus?.median),
    });

    // ── Item condition forensics ──────────────────────────────────────────────
    const conditionForensics = buildConditionForensicsPayload({
      visibleText:  visionIdentity?.visibleText  || [],
      styleWords:   visionIdentity?.styleWords   || [],
      category,
      scannedPrice: finitePrice(scannedPrice),
      medianMarket: finitePrice(consensus?.median),
    });

    // ── Alternative marketplace radar ─────────────────────────────────────────
    const altMarketplaces = buildAlternativeMarketplacePayload({
      identity:    visionIdentity || {},
      category,
      scannedPrice: finitePrice(scannedPrice),
      medianMarket: finitePrice(consensus?.median),
    });

    // ── Cross-listing deduplicator ────────────────────────────────────────────
    const deduplicatedMarket = buildCrossListingDeduplicatorPayload({ uiItems, category });

    // ── Fake listing detector ─────────────────────────────────────────────────
    const fakeDetector = buildFakeListingDetectorPayload({
      title:            visionIdentity?.title        || "",
      description:      visionIdentity?.description  || "",
      scannedPrice:     finitePrice(scannedPrice),
      medianMarket:     finitePrice(consensus?.median),
      category,
      sellerFeedback:   visionIdentity?.sellerFeedback   || null,
      sellerIsNew:      visionIdentity?.sellerIsNew      || false,
      noReturns:        visionIdentity?.noReturns        || false,
      stockPhotoOnly:   visionIdentity?.stockPhotoOnly   || false,
      visionConfidence: visionIdentity?.confidence       || null,
      uiItems,
    });

    // ── Seasonal flip calendar ────────────────────────────────────────────────
    const seasonalFlip = buildSeasonalFlipCalendarPayload({
      category,
      scannedPrice: finitePrice(scannedPrice),
      medianMarket: finitePrice(consensus?.median),
    });

    // ── Brand tier classifier ─────────────────────────────────────────────────
    const brandTier = buildBrandTierPayload({
      identity:    visionIdentity || {},
      category,
      scannedPrice: finitePrice(scannedPrice),
      medianMarket: finitePrice(consensus?.median),
    });

    // ── Smart price target engine ─────────────────────────────────────────────
    const priceTargets = buildSmartPriceTargetPayload({
      scannedPrice:      finitePrice(scannedPrice),
      medianMarket:      finitePrice(consensus?.median),
      dealVerdict:       dealComparator?.verdict || null,
      demandSignals,
      conditionPricing,
      depreciationCurve: depreciationCurve || null,
      category,
    });

    // ── Listing quality scorer ────────────────────────────────────────────────
    const listingQuality = buildListingQualityScorerPayload({
      title:           visionIdentity?.title         || "",
      description:     visionIdentity?.description   || "",
      category,
      scannedPrice:    finitePrice(scannedPrice),
      medianMarket:    finitePrice(consensus?.median),
      dealVerdict:     dealComparator?.verdict        || null,
      photoCount:      visionIdentity?.photoCount     || 0,
      hasMultiAngle:   visionIdentity?.hasMultiAngle  || false,
      stockPhotoOnly:  visionIdentity?.stockPhotoOnly || false,
      hasDefectPhoto:  visionIdentity?.hasDefectPhoto || false,
      lightingQuality: imageContext?.lightingTier     || null,
      sellerProfile:   visionIdentity?.sellerProfile   || {},
      identity:        visionIdentity                || {},
    });

    // ── Market momentum tracker ───────────────────────────────────────────────
    const marketMomentum = buildMarketMomentumPayload({
      uiItems,
      soldItems: intelligence?.soldComp || [],
      category,
    });

    // ── Market depth analyzer ─────────────────────────────────────────────────
    const marketDepth = buildMarketDepthPayload({
      uiItems,
      soldItems: intelligence?.soldComp || [],
      category,
    });

    // ── Resale speed predictor ────────────────────────────────────────────────
    const resaleSpeed = buildResaleSpeedPayload({
      category,
      demandSignals,
      dealComparator,
      conditionPricing,
      marketMomentum,
    });

    // ── Flip score engine ─────────────────────────────────────────────────────
    const flipScore = buildFlipScorePayload({
      priceTargets,
      profitCalc,
      demandSignals,
      marketMomentum,
      riskScore,
      fakeDetector,
      authenticityIntel,
      dealComparator,
      seasonalFlip,
      trendIntel,
    });

    // ── Scan-to-list pipeline ─────────────────────────────────────────────────
    const scanToList = buildScanToListPayload({
      identity:         visionIdentity || {},
      category,
      scannedPrice:     finitePrice(scannedPrice),
      medianMarket:     finitePrice(consensus?.median),
      conditionForensics,
      conditionPricing,
      resaleOptimizer,
    });

    // ── Smart substitute ranker ───────────────────────────────────────────────
    const smartSubstitutes = buildSmartSubstituteRankerPayload({
      scannedPrice:        finitePrice(scannedPrice),
      medianMarket:        finitePrice(consensus?.median),
      dnaMatch,
      colorwaySubstitutes,
      brandTier,
      altMarketplaces,
      deduplicatedMarket,
    });

    // ── Price prediction model ────────────────────────────────────────────────
    const priceProjection = buildPricePredictionPayload({
      scannedPrice:     finitePrice(scannedPrice),
      medianMarket:     finitePrice(consensus?.median),
      category,
      depreciationCurve: depreciationCurve || null,
      marketMomentum,
      trendIntel,
    });

    // ── Authentication service router ─────────────────────────────────────────
    const authServiceRoute = buildAuthServiceRouterPayload({
      identity:         visionIdentity || {},
      category,
      scannedPrice:     finitePrice(scannedPrice),
      medianMarket:     finitePrice(consensus?.median),
      authenticityIntel,
    });

    // ── Counteroffer script builder ───────────────────────────────────────────
    const counterofferScript = buildCounteroferScriptPayload({
      scannedPrice:     finitePrice(scannedPrice),
      medianMarket:     finitePrice(consensus?.median),
      dealVerdict:      dealComparator?.verdict || "fair",
      negotiationIntel,
      conditionForensics,
    });

    const evanSummary = buildEvanSummary({
      dealComparator,
      authenticityIntel,
      demandSignals,
      trendIntel,
      riskScore,
      liquidityScore:   liquidityResult,
      conditionPricing,
      substituteIntel,
      negotiationIntel,
      resaleOptimizer,
      bundleIntel,
      priceHistoryIntel,
      smartAlerts,
      categoryIntel,
      dontBuyThis,
    });

    // ── Evan score explainer (needs full bundle — runs last) ──────────────────
    const evanExplainer = buildEvanScoreExplainerPayload({
      dealComparator,
      consensus,
      scannedPrice:      finitePrice(scannedPrice),
      bestPrice:         finitePrice(bestPrice),
      demandSignals,
      riskScore,
      flipScore,
      conditionForensics,
      authenticityIntel,
      fakeDetector,
      marketMomentum,
      resaleSpeed,
      seasonalFlip,
      smartSubstitutes,
      priceProjection,
      evanSummary,
    });

    // ── Feature 62: Buy or Pass Engine (THE FINAL VERDICT) ────────────────────
    const buyOrPassResult = buildBuyOrPassPayload({
      dealComparator,
      consensus,
      scannedPrice:      finitePrice(scannedPrice),
      bestPrice:         finitePrice(bestPrice),
      demandSignals,
      riskScore,
      flipScore,
      conditionForensics,
      authenticityIntel,
      fakeDetector,
      priceProjection,
      visionIdentity,
      evanSummary,
    });

    // ── Feature 68: Seal / Tag / Sticker Detector ─────────────────────────────
    const sealTags = buildSealTagPayload({
      visibleText:     visionIdentity?.visibleText  || [],
      styleWords:      visionIdentity?.styleWords   || [],
      conditionFlags:  Array.isArray(conditionFlags) ? conditionFlags : [],
      title:           visionIdentity?.title        || "",
      description:     visionIdentity?.description  || "",
      category,
      currentCondition: visionIdentity?.condition   || null,
      basePrice:       finitePrice(scannedPrice),
    });

    // ── Feature 69: Counterfeit Visual Diff ───────────────────────────────────
    const counterfeitDiff = autoRunVisualDiff({
      brand:            visionIdentity?.brand        || "",
      authenticityFlags: Array.isArray(authenticityFlags) ? authenticityFlags : [],
      visibleText:      visionIdentity?.visibleText  || [],
      styleWords:       visionIdentity?.styleWords   || [],
      conditionFlags:   Array.isArray(conditionFlags) ? conditionFlags : [],
      scannedPrice:     finitePrice(scannedPrice),
      medianMarket:     finitePrice(consensus?.median),
      visionConfidence: visionConfidence ?? 0.5,
    });

    // ── Feature 70: Sold Comps Date Filter ────────────────────────────────────
    const soldCompsDateFilter = buildSoldCompsDateFilterPayload(uiItems);

    // ── Feature 71 + 72: Premium Price Sources (async, fire-and-forget on miss) ─
    let premiumPrices = null;
    try {
      if (SERPAPI_KEY && activeQuery) {
        const _ppResult = await buildPremiumPriceSourcesPayload({
          query:    activeQuery,
          serpKey:  SERPAPI_KEY,
          category,
        });
        premiumPrices = _ppResult;
      }
    } catch { /* non-fatal */ }

    // ── Feature 73: Price Floor Tracker ───────────────────────────────────────
    let priceFloor = null;
    try {
      if (activeQuery) {
        const _pfResult = await buildPriceFloorPayload({
          queryOrSku:   activeQuery,
          uiItems,
          currentPrice: finitePrice(scannedPrice),
          redis,
        });
        priceFloor = _pfResult;
      }
    } catch { /* non-fatal */ }

    // ── Feature 75: Condition Tier Pricer ─────────────────────────────────────
    const conditionTierPricing = buildConditionTierPayload(uiItems, visionIdentity?.condition || null);

    // ── Feature 76: Regional Price Variance (async, only if SERP available) ───
    let regionalPricing = null;
    try {
      if (SERPAPI_KEY && activeQuery) {
        const _rpResult = await buildRegionalPricePayload({
          query:   activeQuery,
          serpKey: SERPAPI_KEY,
          category,
        });
        regionalPricing = _rpResult;
      }
    } catch { /* non-fatal */ }

    // ── Feature 77: Lot / Bundle Detector ─────────────────────────────────────
    const lotBundle = buildLotBundlePayload(uiItems, {
      singleUnitMedian: finitePrice(consensus?.median),
      category,
    });

    schedulePhase5PrecomputeSave({
    query: baseQuery,
    finalQuery: activeQuery,
    searchedQueries,
    variants,
    uiItems,
    best,
    bestPrice,
    consensus,
    prediction,
    coach,
    pulse,
    intelligence,
    historical,
    marketHeat: marketPulseScore,
    visionIdentity,
  });

  if (persistSnapshot && Array.isArray(uiItems) && uiItems.length > 0) {
    Promise.resolve()
      .then(() =>
        saveInternalMarketSnapshot(activeQuery, {
          source: retrievalMeta?.source || "live_market",
          searchedQueries,
          variants,
          items: uiItems,
          best,
          consensus,
          prediction,
          coach,
          pulse,
          historical,
          intelligence,
          marketHeat: marketPulseScore,
          visionIdentity,
        })
      )
      .catch((err) => {
        console.warn("⚠️ internal market snapshot persist failed", err?.message || err);
      });
  }

  return {
    ok: true,
    query: baseQuery,
    finalQuery: activeQuery,
    searchedQueries,
    variants,

    items: uiItems,
    top3: uiItems.slice(0, 3),

    market: uiItems,
    results: uiItems,
    best,
    bestPrice,
    totalMatches: uiItems.length,

    visionIdentity,
    authenticityFlags: Array.isArray(authenticityFlags) ? authenticityFlags : [],
    conditionFlags:    Array.isArray(conditionFlags)    ? conditionFlags    : [],
    consensus,
    prediction,
    coach,
    pulse,

      dealHunter,
      sellSide,
      authenticity,
      liquidityScore:   liquidityResult,
      exitStrategy,
      substituteIntel,
      dontBuyThis,
      arbitrageIntel,
      dealComparator,
      trendIntel,
      authenticityIntel,
      resaleOptimizer,
      bundleIntel,
      priceHistoryIntel,
      conditionPricing,
      demandSignals,
      negotiationIntel,
      riskScore,
      categoryIntel,
      smartAlerts,
      profitCalc,
      imageContext,
      evanSummary,
      dnaMatch,
      priceAnomaly,
      depreciationCurve,
      queryArbitrage,
      sizeArbitrage,
      colorwaySubstitutes,
      releaseCalendar,
      conditionForensics,
      altMarketplaces,
      deduplicatedMarket,
      fakeDetector,
      seasonalFlip,
      brandTier,
      priceTargets,
      listingQuality,
      marketMomentum,
      marketDepth,
      resaleSpeed,
      flipScore,
      scanToList,
      smartSubstitutes,
      priceProjection,
      authServiceRoute,
      counterofferScript,
      evanExplainer,
      buyOrPass:    buyOrPassResult?.buyOrPass || null,
      multiAngle:   null, // populated by route layer from multiAngleResult

      // Features 68-77
      sealTags:             sealTags             || null,
      counterfeitDiff:      counterfeitDiff      || null,
      soldCompsDateFilter:  soldCompsDateFilter  || null,
      premiumPrices:        premiumPrices        || null,
      priceFloor:           priceFloor           || null,
      conditionTierPricing: conditionTierPricing || null,
      regionalPricing:      regionalPricing      || null,
      lotBundle:            lotBundle            || null,
      historical,
      intelligence,
      priceHistory: intelligence?.priceHistory || null,
      soldComps: intelligence?.soldComp || null,
      watchSignals: intelligence?.watchSignals || null,
      moatMode,
      marketHeat: marketPulseScore,


    retrieval: retrievalMeta || {
      source: Array.isArray(sourceItems) && sourceItems.length ? "live_market" : "empty",
      kind: Array.isArray(sourceItems) && sourceItems.length ? "live_market" : "empty",
    },
  };
}
app.get("/debug/internal-retrieval", async (req, res) => {
  try {
    const query = normalizeQuery(safeStr(req.query?.q, 220));
    if (!query) {
      return res.status(200).json({
        ok: false,
        error: "missing_query",
      });
    }

    const snapshot = await readInternalMarketSnapshot(query);
    const snapshotState = getInternalSnapshotState(snapshot);
    const internal = await resolveInternalMarketHit(query, null, {
      allowStale: true,
    });

    return res.status(200).json({
      ok: true,
      query,
      snapshotState,
      snapshotSource: snapshot?.source || null,
      snapshotItems: Array.isArray(snapshot?.items) ? snapshot.items.length : 0,
      retrieval: {
        hit: internal.hit,
        source: internal.source,
        kind: internal.kind,
        count: Array.isArray(internal.items) ? internal.items.length : 0,
        counts: internal?.counts || null,
      },
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "internal_retrieval_debug_failed",
      reason: err?.message || String(err),
    });
  }
});

// -------------------- MARKET SEARCH (POST) --------------------
app.post("/market/search", async (req, res) => {
  try {

const rawQuery = safeStr(req.body?.query, 220);
let query = normalizeQuery(rawQuery);
query = bestHistoricalQuery(query);
query = canonicalizeQuery(query);

query = categoryAdapter(
  query,
  req.body?.category || req.body?.visionIdentity?.category || null
);

let visionIdentity = normalizeVisionIdentityPayload(
  req.body?.visionIdentity || req.body?.identity || null,
  query
);

const imageHash =
  safeStr(
    req.body?.imageHash ||
      req.body?.scanAsset?.hash ||
      req.body?.visionIdentity?.imageHash ||
      req.body?.identity?.imageHash,
    128
  ) || null;

if (imageHash) {
  visionIdentity = {
    ...(visionIdentity || {}),
    imageHash,
  };
}

visionIdentity = {
  ...(visionIdentity || {}),
  plan: getResolvedPlan(req),
};

if ((!query || isGarbageQuery(query)) && visionIdentity?.exactQuery) {
  query = normalizeQuery(visionIdentity.exactQuery);
}

if (
  (!query || isGarbageQuery(query)) &&
  Array.isArray(visionIdentity?.searchQueries) &&
  visionIdentity.searchQueries.length
) {
  query = normalizeQuery(visionIdentity.searchQueries[0]);
}

const visualMatchQueries = extractVisualMatchQueries(req.body?.visualMatches);

const variants = normalizeVariantList(
  [
    ...(Array.isArray(req.body?.variants) ? req.body.variants : []),
    ...visualMatchQueries,
    ...(Array.isArray(visionIdentity?.searchQueries) ? visionIdentity.searchQueries : []),
    visionIdentity?.exactQuery,
  ],
  query,
  "item"
);

const scannedPrice = finitePrice(req.body?.scannedPrice);
const visionConfidence = clamp01(
  req.body?.visionConfidence ?? req.body?.confidence ?? 0.5
);

const category =
  safeStr(req.body?.category, 80) ||
  visionIdentity?.category ||
  inferVisionCategory(query);

const identityPreferredQuery = chooseBestIdentityQuery(
  visionIdentity,
  query || ""
);

if (identityPreferredQuery) {
  const currentNorm = normalizeQuery(query || "");
  const preferredNorm = normalizeQuery(identityPreferredQuery || "");

  const currentHasBrand = visionIdentity?.brand
    ? titleContainsLoose(currentNorm, visionIdentity.brand)
    : false;

  const currentHasModel = visionIdentity?.model
    ? titleContainsLoose(currentNorm, visionIdentity.model)
    : false;

  const preferredHasBrand = visionIdentity?.brand
    ? titleContainsLoose(preferredNorm, visionIdentity.brand)
    : false;

  const preferredHasModel = visionIdentity?.model
    ? titleContainsLoose(preferredNorm, visionIdentity.model)
    : false;

  if (
    !currentNorm ||
    isGarbageQuery(currentNorm) ||
    (!currentHasBrand && preferredHasBrand) ||
    (!currentHasModel && preferredHasModel) ||
    titleTokens(preferredNorm).length > titleTokens(currentNorm).length + 1
  ) {
    query = preferredNorm;
  }
}

if (!query) {
  return res.status(200).json({ ok: false, error: "Missing query" });
}

let searchedQueries = buildServerQueryVariants(query, variants, "item", visionIdentity);

// ---------- dual-lane search ---------- 
if (visionIdentity?.exactQuery) {
  const exact = normalizeQuery(visionIdentity.exactQuery);
  if (exact) searchedQueries.unshift(exact);
}

if (visionIdentity?.category) {
  const generic = normalizeQuery(
    `${visionIdentity.colors?.[0] || ""} ${visionIdentity.category}`.trim()
  );
  if (generic) searchedQueries.push(generic);
}

if (!searchedQueries.length) {
  searchedQueries.push(query);
}

if (searchedQueries.length < 3) {
searchedQueries.push(`${query} used`);
searchedQueries.push(`${query} ebay`);
searchedQueries.push(`${query} listing`);
searchedQueries.push(`${query} product`);
searchedQueries.push(`${query} item`);
}

const canonicalKey = canonicalMarketQuery(query);
const canonicalVariantKey = uniqueQueries(
  searchedQueries.map((q) => canonicalMarketQuery(q))
).join("|");
const identityKey = visionIdentity ? hashString(JSON.stringify(visionIdentity)) : "noid";
const cacheKey = `market|${canonicalKey}|${canonicalVariantKey}|${identityKey}`;
// ── Multi-angle consensus (Feature 64) ───────────────────────────────────────
let multiAngleResult = null;
const _visionPasses = Array.isArray(req.body?.visionPasses) ? req.body.visionPasses : [];
if (_visionPasses.length >= 2) {
  try {
    multiAngleResult = buildMultiAngleConsensusPayload(_visionPasses);
    if (multiAngleResult?.ok && multiAngleResult.consensus?.confidence > (visionIdentity?.confidence ?? 0)) {
      const cv = multiAngleResult.consensus;
      visionIdentity = { ...(visionIdentity || {}), ...(cv.identity || {}), confidence: cv.confidence };
      if (cv.query && !multiAngleResult.conflicts?.brandConflict) {
        query = normalizeQuery(cv.query) || query;
      }
    }
  } catch (e) { console.warn("multi_angle_consensus_error", e?.message || e); }
}

// ── Seller jargon normalization (Feature 66) ─────────────────────────────────
try {
  if (query) {
    const _jNorm = normalizeSellerJargon(query);
    if (_jNorm.changed && _jNorm.normalized) query = normalizeQuery(_jNorm.normalized) || query;
  }
} catch { /* non-fatal */ }

const cached = SERP_CACHE.get(cacheKey);

const internalHit = await resolveInternalMarketHit(query, visionIdentity, {
  allowStale: true,
});

const _authFlags = Array.isArray(req.body?.authenticityFlags) ? req.body.authenticityFlags : [];
const _condFlags  = Array.isArray(req.body?.conditionFlags)    ? req.body.conditionFlags    : [];

if (internalHit.hit && Array.isArray(internalHit.items) && internalHit.items.length >= 4) {
  const responsePayload = await buildMarketSearchResponsePayload({
    query,
    searchedQueries,
    variants,
    items: internalHit.items,
    scannedPrice,
    visionConfidence,
    category,
    visionIdentity,
    authenticityFlags: _authFlags,
    conditionFlags:    _condFlags,
    retrievalMeta: {
      source: internalHit.source,
      kind: internalHit.kind,
      snapshotAgeMs: internalHit?.snapshotState?.ageMs ?? null,
      snapshotRefreshedAt: internalHit?.snapshotState?.refreshedAt ?? null,
      counts: internalHit?.counts || null,
    },
    persistSnapshot: false,
  });
  if (multiAngleResult) responsePayload.multiAngle = multiAngleResult;
  return res.status(200).json(responsePayload);
}

if (cached && Array.isArray(cached) && cached.length > 0) {
  const responsePayload = await buildMarketSearchResponsePayload({
    query,
    searchedQueries,
    variants,
    items: cached,
    scannedPrice,
    visionConfidence,
    category,
    visionIdentity,
    authenticityFlags: _authFlags,
    conditionFlags:    _condFlags,
    retrievalMeta: {
      source: "l1_route_cache",
      kind: "route_cache_hit",
    },
    persistSnapshot: false,
  });
  if (multiAngleResult) responsePayload.multiAngle = multiAngleResult;
  return res.status(200).json(responsePayload);
}

let items = await withInflight(cacheKey, async () => {
  const routeCacheKey = `market_route_result:${cacheKey}`;
  const cachedResult = await cacheGet(routeCacheKey);

  if (Array.isArray(cachedResult) && cachedResult.length) {
    return cachedResult;
  }

  const live = await distributedSingleflight.run(
    `market:${cacheKey}`,
    async () => {
      const fresh = await mergeCheapestSources(query, variants, visionIdentity);

      if (Array.isArray(fresh) && fresh.length) {
        await cacheSet(routeCacheKey, fresh, MARKET_ROUTE_CACHE_TTL_SEC);
      }

      return fresh;
    }
  );

  return Array.isArray(live) ? live : [];
});

if ((!Array.isArray(items) || items.length === 0) && Array.isArray(cached) && cached.length > 0) {
  console.warn("⚠️ Using cached fallback market results");
  items = cached;
}

if ((!Array.isArray(items) || items.length === 0) && internalHit?.snapshot?.items?.length) {
  items = internalHit.snapshot.items
    .map(hydrateMarketSnapshotItem)
    .filter((x) => x?.title);
}

if (Array.isArray(items) && items.length > 0) {
  SERP_CACHE.set(cacheKey, items);
}

const responsePayload = await buildMarketSearchResponsePayload({
  query,
  searchedQueries,
  variants,
  items,
  scannedPrice,
  visionConfidence,
  category,
  visionIdentity,
  authenticityFlags: _authFlags,
  conditionFlags:    _condFlags,
  retrievalMeta: {
    source: Array.isArray(items) && items.length > 0 ? "live_market" : "empty",
    kind: Array.isArray(items) && items.length > 0 ? "live_refresh" : "empty",
  },
  persistSnapshot: true,
});
if (multiAngleResult) responsePayload.multiAngle = multiAngleResult;
return res.status(200).json(responsePayload);

  } catch (err) {
    return res.status(200).json({
      ok: true,
      items: [],
      top3: [],
      searchedQueries: [],
      variants: [],
      consensus: buildMarketConsensus([]),
      prediction: buildFlipPrediction({ items: [] }),
      reason: "market_search_failed",
    });
  }
});

app.post("/market/check", async (req, res) => {
  try {
const rawQuery = safeStr(req.body?.query, 220);
let query = normalizeQuery(rawQuery);

let visionIdentity = normalizeVisionIdentityPayload(
  req.body?.visionIdentity || req.body?.identity || null,
  query
);

const imageHash =
  safeStr(
    req.body?.imageHash ||
      req.body?.scanAsset?.hash ||
      req.body?.visionIdentity?.imageHash ||
      req.body?.identity?.imageHash,
    128
  ) || null;

if (imageHash) {
  visionIdentity = {
    ...(visionIdentity || {}),
    imageHash,
  };
}

visionIdentity = {
  ...(visionIdentity || {}),
  plan: getResolvedPlan(req),
};

if ((!query || isGarbageQuery(query)) && visionIdentity?.exactQuery) {
  query = normalizeQuery(visionIdentity.exactQuery);
}

if (
  (!query || isGarbageQuery(query)) &&
  Array.isArray(visionIdentity?.searchQueries) &&
  visionIdentity.searchQueries.length
) {
  query = normalizeQuery(visionIdentity.searchQueries[0]);
}

const visualMatchQueries = extractVisualMatchQueries(req.body?.visualMatches);

const variants = normalizeVariantList(
  [
    ...(Array.isArray(req.body?.variants) ? req.body.variants : []),
    ...visualMatchQueries,
    ...(Array.isArray(visionIdentity?.searchQueries) ? visionIdentity.searchQueries : []),
    visionIdentity?.exactQuery,
  ],
  query,
  "item"
);

const scannedPrice = finitePrice(req.body?.scannedPrice);
const visionConfidence = clamp01(
  req.body?.visionConfidence ?? req.body?.confidence ?? 0.5
);

const category =
  safeStr(req.body?.category, 80) ||
  visionIdentity?.category ||
  inferVisionCategory(query);

const identityPreferredQuery = chooseBestIdentityQuery(
  visionIdentity,
  query || ""
);

if (identityPreferredQuery) {
  const currentNorm = normalizeQuery(query || "");
  const preferredNorm = normalizeQuery(identityPreferredQuery || "");

  const currentHasBrand = visionIdentity?.brand
    ? titleContainsLoose(currentNorm, visionIdentity.brand)
    : false;

  const currentHasModel = visionIdentity?.model
    ? titleContainsLoose(currentNorm, visionIdentity.model)
    : false;

  const preferredHasBrand = visionIdentity?.brand
    ? titleContainsLoose(preferredNorm, visionIdentity.brand)
    : false;

  const preferredHasModel = visionIdentity?.model
    ? titleContainsLoose(preferredNorm, visionIdentity.model)
    : false;

  if (
    !currentNorm ||
    isGarbageQuery(currentNorm) ||
    (!currentHasBrand && preferredHasBrand) ||
    (!currentHasModel && preferredHasModel) ||
    titleTokens(preferredNorm).length > titleTokens(currentNorm).length + 1
  ) {
    query = preferredNorm;
  }
}

if (!query) {
  return res.status(200).json({ ok: false, error: "Missing query" });
}

const searchedQueries = uniqueQueries([
  ...buildServerQueryVariants(query, variants, "item", visionIdentity),
  ...buildEmergencyShoppingFallbacks(query, variants),
  visionIdentity?.exactQuery || "",
  `${query} used`,
  `${query} ebay`,
  `${query} marketplace`,
  `${query} pre owned`,
]).slice(0, 20);
const canonicalKey = canonicalMarketQuery(query);
const canonicalVariantKey = uniqueQueries(
  searchedQueries.map((q) => canonicalMarketQuery(q))
).join("|");
const identityKey = visionIdentity ? hashString(JSON.stringify(visionIdentity)) : "noid";
const cacheKey = `market|${canonicalKey}|${canonicalVariantKey}|${identityKey}`;

const cached = SERP_CACHE.get(cacheKey);

const internalHit = await resolveInternalMarketHit(query, visionIdentity, {
  allowStale: true,
});

const usingInternal =
  internalHit.hit &&
  Array.isArray(internalHit.items) &&
  internalHit.items.length >= 4;

let items;
if (usingInternal) {
  items = internalHit.items;
} else if (cached && Array.isArray(cached) && cached.length > 0) {
  items = cached;
} else {
  items = await withInflight(cacheKey, async () => {
    const routeCacheKey = `market_route_result:${cacheKey}`;
    const cachedResult = await cacheGet(routeCacheKey);

    if (Array.isArray(cachedResult) && cachedResult.length) {
      return cachedResult;
    }

    const live = await distributedSingleflight.run(
      `market:${cacheKey}`,
      async () => {
        const fresh = await mergeCheapestSources(query, variants, visionIdentity);

        if (Array.isArray(fresh) && fresh.length) {
          await cacheSet(routeCacheKey, fresh, MARKET_ROUTE_CACHE_TTL_SEC);
        }

        return fresh;
      }
    );

    return Array.isArray(live) ? live : [];
  });
}

if (!usingInternal && (!cached || !cached.length) && Array.isArray(items) && items.length > 0) {
  SERP_CACHE.set(cacheKey, items);
}

const best = Array.isArray(items) && items.length > 0 ? items[0] : null;
const consensus = buildMarketConsensus(items, scannedPrice, visionConfidence);
const prediction = buildFlipPrediction({
  items,
  scannedPrice,
  visionConfidence,
  category,
});

const finalQuery =
  Array.isArray(items) && items.length > 0
    ? promoteQueryFromMarket(query, items)
    : query;

const coach = buildResaleCoach({
  prediction,
  consensus,
  scannedPrice,
  finalQuery,
});

const pulse = getPulse(finalQuery || query);

if (!usingInternal && Array.isArray(items) && items.length > 0) {
  Promise.resolve()
    .then(() =>
      saveInternalMarketSnapshot(finalQuery || query, {
        source: "market_check_live",
        searchedQueries,
        variants,
        items,
        best,
        consensus,
        prediction,
        coach,
        pulse,
        visionIdentity,
      })
    )
    .catch((err) => {
      console.warn("⚠️ market check snapshot save failed", err?.message || err);
    });
}

return res.status(200).json({
  ok: true,
  query,
  finalQuery,
  searchedQueries,
  variants,
  bestPrice: finitePrice(best?.totalPrice ?? best?.price),
  best,
  items: Array.isArray(items) ? items.slice(0, 3) : [],
  visionIdentity,
  consensus,
  prediction,
  coach,
  pulse,
  retrieval: {
    source: usingInternal ? internalHit.source : "live_market",
    kind: usingInternal ? internalHit.kind : "live_check",
    snapshotAgeMs: usingInternal ? internalHit?.snapshotState?.ageMs ?? null : null,
  },
});
  } catch {
    return res.status(200).json({
      ok: true,
      query: null,
      bestPrice: null,
      best: null,
      items: [],
      searchedQueries: [],
      variants: [],
      consensus: buildMarketConsensus([]),
      prediction: buildFlipPrediction({ items: [] }),
      reason: "market_check_failed",
    });
  }
});

// -------------------- MARKET RESEARCH (POST) --------------------
app.post("/market/research", async (req, res) => {
  try {
    const query = safeStr(req.body?.query, 220);
    const mode = safeStr(req.body?.mode, 24) || "resale";

    if (!query) {
      return res.status(200).json({ ok: false, error: "Missing query" });
    }

    if (!hasAnyMarketSource()) {
      return res.status(200).json({
        ok: true,
        query,
        items: [],
        consensus: buildMarketConsensus([]),
        reason: "missing_market_sources",
      });
    }

    const cacheKey = `research|${mode}|${query}`;
    const cached = RESEARCH_CACHE.get(cacheKey);

    if (cached) {
      return res.status(200).json({
        ok: true,
        query,
        items: cached,
        consensus: buildMarketConsensus(cached),
        cached: true,
      });
    }

    const expansions =
      mode === "cheaper"
        ? [
            `${query} used`,
            `${query} pre-owned`,
            `${query} ebay`,
            `${query} etsy`,
            `${query} poshmark`,
            `${query} depop`,
          ]
        : [query];

    const resultSets = await Promise.all(
      expansions.slice(0, 6).map((q) =>
        marketSearchConcurrency(() => mergeCheapestSources(q, [], null))
      )
    );

    const all = resultSets.flat();

    let cheapest = dedupeSmart(all);
    cheapest = cheapest.filter((it) => !isBadListing(it.title, query));
    cheapest = trimPriceOutliers(cheapest);
    cheapest = intuitionFilter(cheapest);
    cheapest = smartRank(cheapest, query, null);

    RESEARCH_CACHE.set(cacheKey, cheapest);

    return res.status(200).json({
      ok: true,
      query,
      items: cheapest,
      consensus: buildMarketConsensus(cheapest),
    });
  } catch {
    return res.status(200).json({
      ok: true,
      items: [],
      consensus: buildMarketConsensus([]),
      reason: "market_research_failed",
    });
  }
});


// ✅ NEW FEATURE: batch check for watchlists
app.post("/market/batch-check", async (req, res) => {
  try {
    const queries = Array.isArray(req.body?.queries) ? req.body.queries : [];
    const cleaned = queries
      .map((q) => normalizeQuery(safeStr(q, 220)))
      .filter(Boolean)
      .slice(0, 25);

    if (!cleaned.length) {
      return res.status(200).json({ ok: false, error: "Missing queries[]" });
    }

    if (!hasAnyMarketSource()) {
      return res.status(200).json({
        ok: true,
        results: [],
        reason: "missing_market_sources",
      });
    }

    const batchLimiter = pLimit(4);

    const results = await Promise.all(
      cleaned.map((q) =>
        batchLimiter(async () => {
          const key = `check_cheapest|${q}`;
          const cached = SERP_CACHE.get(key);
          const items = cached || (await mergeCheapestSources(q));

          if (!cached) {
            SERP_CACHE.set(key, items);
          }

          const consensus = buildMarketConsensus(items);
          const prediction = buildFlipPrediction({
            items,
            scannedPrice: null,
            visionConfidence: 0.5,
            category: inferVisionCategory(q),
          });

          return {
            query: q,
            bestPrice: finitePrice(items[0]?.totalPrice ?? items[0]?.price),
            best: items[0] ?? null,
            consensus,
            prediction,
            pulse: getPulse(q),
          };
        })
      )
    );

    return res.status(200).json({ ok: true, results });
  } catch {
    return res.status(200).json({ ok: false, error: "batch_check_failed" });
  }
});

// -------------------- LOCAL + ESTATE SEARCH (POST) --------------------
app.post("/local/search", async (req, res) => {
  try {
    const query = safeStr(req.body?.query, 220);
    const near = safeStr(req.body?.near, 80) || "near me";
    if (!query || !SERPAPI_KEY) return res.status(200).json({ ok: true, items: [] });

    const cacheKey = `local|${query}|${near}`;
    const cached = LOCAL_CACHE.get(cacheKey);
    if (cached) return res.status(200).json({ ok: true, items: cached, cached: true });

    const q = `${query} ${near} consignment OR thrift OR estate sale`;

    const params = new URLSearchParams({
      engine: "google",
      q,
      hl: "en",
      gl: "us",
      api_key: SERPAPI_KEY,
    });

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 7000);


    const r = await fetch(`https://serpapi.com/search.json?${params.toString()}`, {
      signal: controller.signal,
    });
    clearTimeout(t);

    const data = await r.json();
    const organic = Array.isArray(data?.organic_results) ? data.organic_results : [];

    const items = organic
      .slice(0, 10)
      .map((o) => ({
        title: o.title || null,
        link: o.link || null,
        snippet: o.snippet || null,
        source: o.source || "Local",
      }))
      .filter((x) => x.title && x.link);

    LOCAL_CACHE.set(cacheKey, items);
    return res.status(200).json({ ok: true, items });
  } catch {
    return res.status(200).json({ ok: true, items: [] });
  }
});

app.use(
  [
    "/referral/create",
    "/referral/redeem",
    "/referral/bonus",
    "/referral/stats",
    "/history/load",
    "/history/save",
    "/saved-scans/list",
    "/saved-scans/save",
    "/saved-scans/delete",
    "/watchlist/list",
    "/watchlist/upsert",
    "/watchlist/delete",
    "/user/profile",
    "/user/profile/upsert",
    "/notifications",
    "/notifications/read",
    "/watch/refresh/enqueue",
    "/watch/poll",
    "/watch/recheck",
    "/analytics/event",
  ],
  requireProductAccess,
  requireSelfUserId
);

// -------------------- REFERRAL ROUTES --------------------

// Create referral code
app.post("/referral/create", async (req, res) => {
  try {
    const userId = safeStr(req.body?.userId, 64);

    if (!userId) {
      return res.status(200).json({
        ok: false,
        error: "sign_in_required",
        reason: "sign_in_required",
      });
    }

    const code = await createReferral(userId);
    if (!code) {
      return res.status(200).json({
        ok: false,
        error: "redis_unavailable",
      });
    }

    const stats = await getReferralByOwner(userId);
    const bonusScans = await getBonusScans(userId);

    return res.status(200).json({
      ok: true,
      code,
      totalUses: Number(stats?.uses || 0),
      referralUses: Number(stats?.uses || 0),
      bonusScans: Number(bonusScans || 0),
    });
  } catch {
    return res.status(200).json({ ok: false });
  }
});

// Redeem referral
app.post(
  "/referral/redeem",
  createIdempotencyMiddleware("referral_redeem"),
  async (req, res) => {
  try {
    const code = safeStr(req.body?.code, 32).toUpperCase();
    const userId = safeStr(req.body?.userId, 64);
    const source = safeStr(req.body?.source, 24) || "manual";

    if (!code || !userId) {
      return res.status(200).json({
        ok: false,
        error: "sign_in_required",
        reason: "sign_in_required",
      });
    }

    const result = await redeemReferral({
      code,
      userId,
      source,
    });

    if (!result?.ok) {
      return res.status(200).json(result);
    }

    const redeemerBonusScans = await addBonusScans(
      userId,
      REFERRAL_BONUS_REWARD
    );
    const ownerBonusScans = await addBonusScans(
      result.ownerId,
      REFERRAL_BONUS_REWARD
    );

    return res.status(200).json({
      ok: true,
      code: result.code,
      ownerId: result.ownerId,
      uses: Number(result.uses || 0),
      bonusScans: Number(redeemerBonusScans || 0),
      reward: {
        amount: REFERRAL_BONUS_REWARD,
        redeemerBonusScans: Number(redeemerBonusScans || 0),
        ownerBonusScans: Number(ownerBonusScans || 0),
      },
      referredBy: result.code,
      source: result.source || source,
    });
  } catch {
    return res.status(200).json({ ok: false });
  }
});

app.get("/referral/bonus", async (req, res) => {
  try {
    const userId = safeStr(req.query?.userId, 64);
    if (!userId) {
      return res.status(200).json({ ok: false, bonusScans: 0 });
    }

    const bonusScans = await getBonusScans(userId);
    return res.status(200).json({ ok: true, bonusScans });
  } catch {
    return res.status(200).json({ ok: false, bonusScans: 0 });
  }
});

// Get referral stats
app.get("/referral/stats", async (req, res) => {
  try {
    const userId = safeStr(req.query?.userId, 64);

    if (!userId || !redis) {
      return res.status(200).json({
        ok: false,
        error: "sign_in_required",
        reason: "sign_in_required",
      });
    }

    const code = await createReferral(userId);
    const record = await getReferralByOwner(userId);
    const bonusScans = await getBonusScans(userId);

    let referredBy = null;
    try {
      const rawRedeem = await redis.get(referralUserKey(userId));
      if (rawRedeem) {
        const parsed = JSON.parse(rawRedeem);
        referredBy = parsed?.code || null;
      }
    } catch {}

    return res.status(200).json({
      ok: true,
      code: code || null,
      totalUses: Number(record?.uses || 0),
      referralUses: Number(record?.uses || 0),
      bonusScans: Number(bonusScans || 0),
      referredBy,
    });
  } catch {
    return res.status(200).json({ ok: false });
  }
});

function round2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function finitePrice(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? round2(v) : null;
}

function compactSavedItem(item = {}) {
  return {
    title: item?.title || null,
    source: item?.source || null,
    price: finitePrice(item?.totalPrice ?? item?.price),
    url: item?.url || item?.buyLink || item?.link || null,
    image: item?.image || null,
    dealScore: Number(item?.dealScore || 0),
    flipScore: Number(item?.flipScore || 0),
  };
}

function userHistoryKey(userId) {
  return `user_history:v2:${safeStr(userId, 64)}`;
}

async function saveScanHistoryRecord(userId, record = {}) {
  if (!redis || !userId) return null;

  const payload = {
    id:
      safeStr(record?.id, 80) ||
      `hist_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    query: normalizeQuery(record?.query || "") || null,
    finalQuery: normalizeQuery(record?.finalQuery || record?.query || "") || null,
    best: record?.best ? compactSavedItem(record.best) : null,
    bestPrice: finitePrice(record?.bestPrice ?? record?.best?.totalPrice ?? record?.best?.price),
    top3: Array.isArray(record?.items)
      ? record.items.slice(0, 3).map((x) => compactSavedItem(x))
      : [],
    imageHash:
      safeStr(record?.imageHash || record?.visionIdentity?.imageHash, 128) || null,
    visionIdentity: record?.visionIdentity || null,
    prediction: record?.prediction || null,
    consensus: record?.consensus || null,
    coach: record?.coach || null,
    createdAt: Number(record?.createdAt || Date.now()),
  };

  await redis.lpush(userHistoryKey(userId), JSON.stringify(payload));
  await redis.ltrim(userHistoryKey(userId), 0, 199);
  return payload;
}

async function listScanHistoryRecords(userId, limit = 50) {
  if (!redis || !userId) return [];

  const rows = await redis.lrange(userHistoryKey(userId), 0, Math.max(0, limit - 1));
  const out = [];

  for (const raw of rows) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {}
  }

  return out;
}

function savedScanIndexKey(userId) {
  return `saved_scans:index:${safeStr(userId, 64)}`;
}

function savedScanDocKey(userId, scanId) {
  return `saved_scans:doc:${safeStr(userId, 64)}:${safeStr(scanId, 80)}`;
}

async function saveSavedScanRecord(userId, record = {}) {
  if (!redis || !userId) return null;

  const id =
    safeStr(record?.id, 80) ||
    `scan_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  const existingRaw = await redis.get(savedScanDocKey(userId, id));
  let existing = null;

  try {
    existing = existingRaw ? JSON.parse(existingRaw) : null;
  } catch {
    existing = null;
  }

  const payload = {
    id,
    query: normalizeQuery(record?.query || record?.finalQuery || "") || null,
    finalQuery: normalizeQuery(record?.finalQuery || record?.query || "") || null,
    title:
      safeStr(record?.title, 220) ||
      safeStr(record?.best?.title, 220) ||
      null,
    imageHash:
      safeStr(record?.imageHash || record?.visionIdentity?.imageHash, 128) || null,
    best: record?.best ? compactSavedItem(record.best) : null,
    bestPrice: finitePrice(record?.bestPrice ?? record?.best?.totalPrice ?? record?.best?.price),
    top3: Array.isArray(record?.items)
      ? record.items.slice(0, 3).map((x) => compactSavedItem(x))
      : [],
    visionIdentity: record?.visionIdentity || null,
    prediction: record?.prediction || null,
    consensus: record?.consensus || null,
    notes: safeStr(record?.notes, 500) || null,
    createdAt: Number(existing?.createdAt || Date.now()),
    updatedAt: Date.now(),
  };

  await redis
    .multi()
    .set(savedScanDocKey(userId, id), JSON.stringify(payload))
    .zadd(savedScanIndexKey(userId), payload.updatedAt, id)
    .exec();

  return payload;
}

async function listSavedScanRecords(userId, limit = 100) {
  if (!redis || !userId) return [];

  const ids = await redis.zrevrange(savedScanIndexKey(userId), 0, Math.max(0, limit - 1));
  if (!ids.length) return [];

  const raws = await redis.mget(ids.map((id) => savedScanDocKey(userId, id)));
  const out = [];

  for (const raw of raws) {
    try {
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {}
  }

  return out;
}

async function deleteSavedScanRecord(userId, scanId) {
  if (!redis || !userId || !scanId) return false;

  await redis
    .multi()
    .del(savedScanDocKey(userId, scanId))
    .zrem(savedScanIndexKey(userId), scanId)
    .exec();

  return true;
}

function watchlistIndexKey(userId) {
  return `watchlist:index:${safeStr(userId, 64)}`;
}

function watchlistDocKey(userId, itemId) {
  return `watchlist:doc:${safeStr(userId, 64)}:${safeStr(itemId, 80)}`;
}

async function upsertWatchlistItem(userId, item = {}) {
  if (!redis || !userId) return null;

  const normalizedQuery = normalizeQuery(item?.query || item?.title || "");
  if (!normalizedQuery) return null;

  const id =
    safeStr(item?.id, 80) || `watch_${hashString(normalizedQuery)}`;

  const existingRaw = await redis.get(watchlistDocKey(userId, id));
  let existing = null;

  try {
    existing = existingRaw ? JSON.parse(existingRaw) : null;
  } catch {
    existing = null;
  }

  const payload = {
    id,
    query: normalizedQuery,
    title: safeStr(item?.title, 220) || normalizedQuery,
    image: safeStr(item?.image, 400) || null,
    notes: safeStr(item?.notes, 500) || null,
    targetPrice: finitePrice(item?.targetPrice),
    desiredBuyPrice: finitePrice(item?.desiredBuyPrice ?? item?.targetPrice),
    createdAt: Number(existing?.createdAt || Date.now()),
    updatedAt: Date.now(),
  };

  await redis
    .multi()
    .set(watchlistDocKey(userId, id), JSON.stringify(payload))
    .zadd(watchlistIndexKey(userId), payload.updatedAt, id)
    .exec();

  return payload;
}

async function listLocalWatchlistItems(userId, limit = 200) {
  if (!redis || !userId) return [];

  const ids = await redis.zrevrange(watchlistIndexKey(userId), 0, Math.max(0, limit - 1));
  if (!ids.length) return [];

  const raws = await redis.mget(ids.map((id) => watchlistDocKey(userId, id)));
  const out = [];

  for (const raw of raws) {
    try {
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {}
  }

  return out;
}

async function deleteWatchlistItem(userId, itemId) {
  if (!redis || !userId || !itemId) return false;

  await redis
    .multi()
    .del(watchlistDocKey(userId, itemId))
    .zrem(watchlistIndexKey(userId), itemId)
    .exec();

  return true;
}

async function persistPhase2ScanRecord({
  userId,
  query,
  finalQuery,
  best,
  items,
  visionIdentity,
  prediction,
  consensus,
  coach,
} = {}) {
  if (!userId) return null;

  return await saveScanHistoryRecord(userId, {
    query,
    finalQuery,
    best,
    bestPrice: finitePrice(best?.totalPrice ?? best?.price),
    items,
    visionIdentity,
    prediction,
    consensus,
    coach,
  });
}

function watchStorageKey(userId, query) {
  return `watch:${safeStr(userId, 64)}:${hashString(normalizeQuery(query))}`;
}

async function loadWatchState(userId, query) {
  if (!redis || !userId || !query) return null;

  try {
    const raw = await redis.get(watchStorageKey(userId, query));
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function saveWatchState(userId, query, value) {
  if (!redis || !userId || !query) return;

  try {
    await redis.set(watchStorageKey(userId, query), JSON.stringify(value));
  } catch {}
}

function bonusScansKey(userId) {
  return `bonus_scans:${safeStr(userId, 64)}`;
}

async function getBonusScans(userId) {
  if (!redis || !userId) return 0;

  try {
    const raw = await redis.get(bonusScansKey(userId));
    const n = Number(raw || 0);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function addBonusScans(userId, amount = 1) {
  if (!redis || !userId || !Number.isFinite(amount) || amount <= 0) return 0;

  try {
    const next = await redis.incrby(bonusScansKey(userId), amount);
    return Number(next || 0);
  } catch {
    return 0;
  }
}

function computeWatchDelta(prev, items = []) {
  const best = items[0] || null;

  const nextBestPrice = finitePrice(best?.totalPrice ?? best?.price);
  const prevBestPrice = finitePrice(prev?.lastBestPrice);

  const sourceChanged =
    String(prev?.bestSource || "") !== String(best?.source || "");

  const changed = prevBestPrice !== nextBestPrice || sourceChanged;

  const priceDropped =
    prevBestPrice != null &&
    nextBestPrice != null &&
    nextBestPrice < prevBestPrice;

  const dropAmount = priceDropped
    ? round2(prevBestPrice - nextBestPrice)
    : 0;

  const dropPct =
    priceDropped && prevBestPrice > 0
      ? round2((dropAmount / prevBestPrice) * 100)
      : 0;

  const newLow =
    nextBestPrice != null &&
    (!Number.isFinite(prev?.lowestSeen) || nextBestPrice < prev.lowestSeen);

  const significant =
    dropPct >= 8 ||
    dropAmount >= 10 ||
    newLow;

  return {
    changed,
    priceDropped,
    dropAmount,
    dropPct,
    newLow,
    sourceChanged,
    significant,
  };
}

function buildWatchState(query, items = [], prev = null, delta = null) {
  const best = items[0] || null;
  const bestPrice = finitePrice(best?.totalPrice ?? best?.price);
  const consensus = buildMarketConsensus(items);

  const prevLowest = Number.isFinite(prev?.lowestSeen) ? prev.lowestSeen : null;
  const prevHighest = Number.isFinite(prev?.highestSeen) ? prev.highestSeen : null;
  const prevDropCount = Number(prev?.dropCount || 0);
  const prevBiggestDrop = Number(prev?.biggestDrop || 0);

  return {
    query,
    lastBestPrice: bestPrice,
    previousBestPrice: finitePrice(prev?.lastBestPrice),
    bestSource: best?.source || null,
    bestTitle: best?.title || null,
    firstSeenAt: prev?.firstSeenAt || Date.now(),
    lastCheckedAt: Date.now(),
    lowestSeen:
      bestPrice == null
        ? prevLowest
        : prevLowest == null
        ? bestPrice
        : Math.min(prevLowest, bestPrice),
    highestSeen:
      bestPrice == null
        ? prevHighest
        : prevHighest == null
        ? bestPrice
        : Math.max(prevHighest, bestPrice),
    dropCount: delta?.priceDropped ? prevDropCount + 1 : prevDropCount,
    biggestDrop: delta?.priceDropped
      ? Math.max(prevBiggestDrop, Number(delta.dropAmount || 0))
      : prevBiggestDrop,
    volatility: resaleProbability(
      (items || []).map((it) => ({
        ...it,
        price: it?.totalPrice ?? it?.price,
      }))
    ),
    marketConfidence: consensus.consensusScore,
    lastDelta: delta || null,
  };
}

async function runWatchCheck(userId, rawQuery) {
  const query = normalizeQuery(safeStr(rawQuery, 220));
  if (!userId || !query) return null;

  const prev = await loadWatchState(userId, query);

  const cacheKey = `watch_check|${canonicalMarketQuery(query)}`;
  let items = SERP_CACHE.get(cacheKey);

  if (!Array.isArray(items) || !items.length) {
    if (!hasAnyMarketSource() && !SERPAPI_KEY) {
      items = [];
    } else {
      items = await mergeCheapestSources(query);
      if (Array.isArray(items) && items.length) {
        SERP_CACHE.set(cacheKey, items);
      }
    }
  }

  const delta = computeWatchDelta(prev, items);
  const state = buildWatchState(query, items, prev, delta);
  const consensus = buildMarketConsensus(items);

  await saveWatchState(userId, query, state);

  const watchSignals = await recordWatchHeartbeat({
    userId,
    query,
    bestPrice: finitePrice(items[0]?.totalPrice ?? items[0]?.price),
    state,
    consensus,
  });

  await recordCrawlerRefresh(query, items, {
    reason: "watch_check",
  });

  return {
    query,
    bestPrice: finitePrice(items[0]?.totalPrice ?? items[0]?.price),
    best: items[0] ?? null,
    delta,
    state,
    consensus,
    watchSignals,
  };
}

// -------------------- LIGHTWEIGHT APP ROUTES REQUIRED BY FRONTEND --------------------

// in-memory analytics sink (safe dev stub)
const analyticsEvents = [];

// analytics event
app.post("/analytics/event", async (req, res) => {
  try {
    const userId = safeStr(req.body?.userId, 64);
    const event = safeStr(req.body?.event, 64);
    const payload = req.body?.payload ?? {};
    const ts =
      typeof req.body?.ts === "number" ? req.body.ts : Date.now();

    analyticsEvents.unshift({
      userId,
      event,
      payload,
      ts,
    });

    if (analyticsEvents.length > 1000) {
      analyticsEvents.length = 1000;
    }

    if (userId) {
      await maybeHydrateUserFromActivity(userId, {});
    }

    const analyticsJobId = queueAnalyticsEvent({
      userId,
      event,
      payload,
      ts,
    });

    return res.status(200).json({
      ok: true,
      analyticsJobId,
      queued: true,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "analytics_enqueue_failed",
      reason: err?.message || String(err),
    });
  }
});

// history load (safe dev stub)
app.get("/history/load", async (req, res) => {
  try {
    const userId = safeStr(req.query?.userId, 64);
    if (!userId) return res.status(200).json([]);

    const items = await listScanHistoryRecords(
      userId,
      Math.max(1, Math.min(100, Number(req.query?.limit || 50)))
    );

    return res.status(200).json(items);
  } catch {
    return res.status(200).json([]);
  }
});

app.post("/history/save", async (req, res) => {
  try {
    const userId = safeStr(req.body?.userId, 64);
    if (!userId) {
      return res.status(200).json({ ok: false, error: "missing_user_id" });
    }

    const saved = await saveScanHistoryRecord(userId, {
      query: req.body?.query,
      finalQuery: req.body?.finalQuery,
      best: req.body?.best,
      items: req.body?.items,
      visionIdentity: req.body?.visionIdentity || req.body?.identity || null,
      prediction: req.body?.prediction || null,
      consensus: req.body?.consensus || null,
      coach: req.body?.coach || null,
    });

    return res.status(200).json({
      ok: !!saved,
      item: saved,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "history_save_failed",
      reason: err?.message || String(err),
    });
  }
});

app.get("/saved-scans/list", async (req, res) => {
  try {
    const userId = safeStr(req.query?.userId, 64);
    if (!userId) {
      return res.status(200).json({ ok: false, error: "missing_user_id" });
    }

    const items = await listSavedScanRecords(
      userId,
      Math.max(1, Math.min(200, Number(req.query?.limit || 100)))
    );

    return res.status(200).json({
      ok: true,
      items,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "saved_scans_list_failed",
      reason: err?.message || String(err),
    });
  }
});

app.post("/saved-scans/save", async (req, res) => {
  try {
    const userId = safeStr(req.body?.userId, 64);
    if (!userId) {
      return res.status(200).json({ ok: false, error: "missing_user_id" });
    }

    const item = await saveSavedScanRecord(userId, {
      id: req.body?.id,
      query: req.body?.query,
      finalQuery: req.body?.finalQuery,
      title: req.body?.title,
      best: req.body?.best,
      bestPrice: req.body?.bestPrice,
      items: req.body?.items,
      visionIdentity: req.body?.visionIdentity || req.body?.identity || null,
      prediction: req.body?.prediction || null,
      consensus: req.body?.consensus || null,
      notes: req.body?.notes || null,
    });

    return res.status(200).json({
      ok: !!item,
      item,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "saved_scan_save_failed",
      reason: err?.message || String(err),
    });
  }
});

app.post("/saved-scans/delete", async (req, res) => {
  try {
    const userId = safeStr(req.body?.userId, 64);
    const id = safeStr(req.body?.id, 80);

    if (!userId || !id) {
      return res.status(200).json({ ok: false, error: "missing_fields" });
    }

    await deleteSavedScanRecord(userId, id);

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "saved_scan_delete_failed",
      reason: err?.message || String(err),
    });
  }
});

app.get("/watchlist/list", async (req, res) => {
  try {
    const userId = safeStr(req.query?.userId, 64);
    if (!userId) {
      return res.status(200).json({ ok: false, error: "missing_user_id" });
    }

    const items = await listLocalWatchlistItems(
      userId,
      Math.max(1, Math.min(200, Number(req.query?.limit || 100)))
    );

    return res.status(200).json({
      ok: true,
      items,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "watchlist_load_failed",
      reason: err?.message || String(err),
    });
  }
});

app.post("/watchlist/upsert", async (req, res) => {
  try {
    const userId = safeStr(req.body?.userId, 64);
    if (!userId) {
      return res.status(200).json({ ok: false, error: "missing_user_id" });
    }

    const item = await upsertWatchlistItem(userId, req.body?.item || req.body);

    return res.status(200).json({
      ok: !!item,
      item,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "watchlist_upsert_failed",
      reason: err?.message || String(err),
    });
  }
});

app.post("/watchlist/delete", async (req, res) => {
  try {
    const userId = safeStr(req.body?.userId, 64);
    const id = safeStr(req.body?.id, 80);

    if (!userId || !id) {
      return res.status(200).json({ ok: false, error: "missing_fields" });
    }

    await deleteWatchlistItem(userId, id);

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "watchlist_delete_failed",
      reason: err?.message || String(err),
    });
  }
});

app.get("/user/profile", async (req, res) => {
  try {
    const userId = safeStr(req.query?.userId, 64);
    if (!userId) {
      return res.status(200).json({ ok: false, error: "missing_user_id" });
    }

    const profile = await getUserProfile(userId);
    return res.status(200).json({
      ok: true,
      profile: profile || null,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "profile_load_failed",
      reason: err?.message || String(err),
    });
  }
});

app.post("/user/profile/upsert", async (req, res) => {
  try {
    const userId = safeStr(req.body?.userId, 64);
    if (!userId) {
      return res.status(200).json({ ok: false, error: "missing_user_id" });
    }

    const patch = {
      name: safeStr(req.body?.name, 120) || undefined,
      email: safeStr(req.body?.email, 180) || undefined,
      username: safeStr(req.body?.username, 120) || undefined,
      avatarUrl: safeStr(req.body?.avatarUrl, 400) || undefined,
      pro: typeof req.body?.pro === "boolean" ? req.body.pro : undefined,
      preferences:
        req.body?.preferences && typeof req.body.preferences === "object"
          ? req.body.preferences
          : undefined,
      lastKnownQuery: safeStr(req.body?.lastKnownQuery, 220) || undefined,
    };

    const cleanedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined)
    );

    const profile = await upsertUserProfile(userId, cleanedPatch);

    return res.status(200).json({
      ok: true,
      profile,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "profile_upsert_failed",
      reason: err?.message || String(err),
    });
  }
});

app.get("/notifications", async (req, res) => {
  try {
    const userId = safeStr(req.query?.userId, 64);
    const limit = Math.max(1, Math.min(100, Number(req.query?.limit || 50)));

    if (!userId) {
      return res.status(200).json({ ok: false, error: "missing_user_id" });
    }

    const items = await listNotifications(userId, limit);

    return res.status(200).json({
      ok: true,
      items,
      unread: items.filter((x) => !x?.read).length,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "notifications_load_failed",
      reason: err?.message || String(err),
    });
  }
});

app.post(
  "/notifications/read",
  createIdempotencyMiddleware("notifications_read"),
  async (req, res) => {
  try {
    const userId = safeStr(req.body?.userId, 64);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const all = req.body?.all === true;

    if (!userId) {
      return res.status(200).json({ ok: false, error: "missing_user_id" });
    }

    const items = await markNotificationsRead({
      userId,
      ids,
      all,
    });

    return res.status(200).json({
      ok: true,
      items: items.slice(0, 100),
      unread: items.filter((x) => !x?.read).length,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "notifications_read_failed",
      reason: err?.message || String(err),
    });
  }
});

app.get("/analytics/summary", async (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, Number(req.query?.days || 7)));
    const summary = await getAnalyticsSummary(days);

    return res.status(200).json({
      ok: true,
      summary,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "analytics_summary_failed",
      reason: err?.message || String(err),
    });
  }
});

app.get("/precompute/query", async (req, res) => {
  try {
    const query = normalizeQuery(safeStr(req.query?.q, 220));
    if (!query) {
      return res.status(200).json({ ok: false, error: "missing_query" });
    }

    const snapshot = await getPrecomputeSnapshot(query);

    return res.status(200).json({
      ok: true,
      query,
      snapshot: snapshot || null,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "precompute_load_failed",
      reason: err?.message || String(err),
    });
  }
});

app.post("/deal/hunt", async (req, res) => {
  try {
    const rawQuery = safeStr(req.body?.query, 220);
    const query = normalizeQuery(rawQuery);

    if (!query) {
      return res.status(200).json({ ok: false, error: "Missing query" });
    }

    const items = await mergeCheapestSources(query, [], req.body?.visionIdentity || null);
    const historical =
      getHistoricalStats(query) ||
      productStats(query) ||
      null;

    const payload = buildDealHunterPayload(query, items, {
      scannedPrice: finitePrice(req.body?.scannedPrice),
      historicalAvg: historical?.avg ?? null,
      marketAvg: historical?.avg ?? null,
      marketHeat: marketHeat(query),
    });

    return res.status(200).json({
      ok: true,
      query,
      payload,
      items: Array.isArray(items) ? items.slice(0, 10) : [],
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "deal_hunt_failed",
      reason: err?.message || String(err),
    });
  }
});

app.post("/sell/estimate", async (req, res) => {
  try {
    const rawQuery = safeStr(req.body?.query, 220);
    const query = normalizeQuery(rawQuery);

    if (!query) {
      return res.status(200).json({ ok: false, error: "Missing query" });
    }

    const items = await mergeCheapestSources(query, [], req.body?.visionIdentity || null);

    const payload = buildSellSideEstimate(query, items, {
      scannedPrice: finitePrice(req.body?.scannedPrice),
      marketHeat: marketHeat(query),
    });

    return res.status(200).json({
      ok: true,
      query,
      payload,
      items: Array.isArray(items) ? items.slice(0, 10) : [],
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "sell_estimate_failed",
      reason: err?.message || String(err),
    });
  }
});

app.post("/watch/refresh/enqueue", async (req, res) => {
  try {
    const userId = safeStr(req.body?.userId, 64) || null;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    const cleaned = items
      .map((it) => ({
        id: it?.id || null,
        query: normalizeQuery(safeStr(it?.query || it?.title, 220)),
      }))
      .filter((it) => it.query)
      .slice(0, 25);

    if (!cleaned.length) {
      return res.status(200).json({
        ok: false,
        error: "missing_items",
      });
    }

    const jobIds = cleaned.map((it) =>
      queueWatchRefresh(userId, it.query, { id: it.id || null })
    );

    return res.status(200).json({
      ok: true,
      queued: true,
      jobIds,
      count: jobIds.length,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "watch_refresh_enqueue_failed",
      reason: err?.message || String(err),
    });
  }
});

// watch poll (frontend expects this)
app.post(
  "/watch/poll",
  createIdempotencyMiddleware("watch_poll"),
  async (req, res) => {
  try {
    const userId = safeStr(req.body?.userId, 64) || null;
        if (userId) {
      await maybeHydrateUserFromActivity(userId, {});
    }
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!items.length) {
      return res.status(200).json({
        ok: true,
        items: [],
        updated: [],
        drops: [],
      });
    }

    const cleaned = items
      .map((it) => ({
        id: it?.id || null,
        query: normalizeQuery(safeStr(it?.query || it?.title, 220)),
      }))
      .filter((it) => it.query)
      .slice(0, 25);

    const updated = [];
    const drops = [];

    for (const it of cleaned) {
      const result = await runWatchCheck(userId, it.query);
      if (!result) continue;

      const payload = {
        id: it.id || result.query,
        query: result.query,
        estValue: finitePrice(result.bestPrice),
        marketLow: finitePrice(result.consensus?.typicalLow),
        marketHigh: finitePrice(result.consensus?.typicalHigh),
        bestPrice: finitePrice(result.bestPrice),
        best: result.best,
        dropAmount: finitePrice(result.delta?.dropAmount),
        dropPct: finitePrice(result.delta?.dropPct),
        dropCount: Number(result.state?.dropCount || 0),
        priceDropped: !!result.delta?.priceDropped,
        lastChecked: Number(result.state?.lastCheckedAt || Date.now()),
        delta: result.delta,
        state: result.state,
        consensus: result.consensus,
        watchSignals: result.watchSignals || null,
      };

      updated.push(payload);

      if (payload.priceDropped && result.delta?.significant) {
        drops.push(payload);
      }
      if (userId && payload.priceDropped && result.delta?.significant) {
        queueNotificationFanout({
          userId,
          kind: "price_drop",
          title: "Price drop detected",
          body: `${payload.query} dropped to $${payload.bestPrice ?? "?"}`,
          dedupeKey: `price_drop:${payload.query}:${payload.bestPrice}`,
          data: {
            query: payload.query,
            bestPrice: payload.bestPrice,
            dropAmount: payload.dropAmount,
            dropPct: payload.dropPct,
            source: payload?.best?.source || null,
            title: payload?.best?.title || null,
          },
          cooldownMs: 12 * 60 * 60 * 1000,
        });
      }
    }

// Phase 2: watchlist intelligence
if (Array.isArray(updated)) {
  for (const item of updated) {
    recordWatch(item.query || "", item);
  }
}

    return res.status(200).json({
      ok: true,
      items: updated,
      updated,
      drops,
    });
  } catch {
    return res.status(200).json({
      ok: true,
      items: [],
      updated: [],
      drops: [],
    });
  }
});

// watch recheck (frontend expects this)
app.post(
  "/watch/recheck",
  createIdempotencyMiddleware("watch_recheck"),
  async (req, res) => {
  try {
    const userId = safeStr(req.body?.userId, 64) || null;
        if (userId) {
      await maybeHydrateUserFromActivity(userId, {});
    }
    const item = req.body?.item || null;
    const query = normalizeQuery(safeStr(item?.query || item?.title, 220));

    if (!query) {
      return res.status(200).json({ ok: false, error: "missing_fields" });
    }

    if (!hasAnyMarketSource()) {
      return res.status(200).json({
        ok: true,
        query,
        bestPrice: null,
        best: null,
        estValue: null,
        marketLow: null,
        marketHigh: null,
        consensus: buildMarketConsensus([]),
        reason: "missing_market_sources",
      });
    }

    const result = await runWatchCheck(userId, query);

    if (userId && result?.delta?.priceDropped && result?.delta?.significant) {
      queueNotificationFanout({
        userId,
        kind: "price_drop",
        title: "Price drop detected",
        body: `${result?.query || query} dropped to $${result?.bestPrice ?? "?"}`,
        dedupeKey: `price_drop:${result?.query || query}:${result?.bestPrice ?? "?"}`,
        data: {
          query: result?.query || query,
          bestPrice: result?.bestPrice ?? null,
          dropAmount: result?.delta?.dropAmount ?? null,
          dropPct: result?.delta?.dropPct ?? null,
          source: result?.best?.source || null,
          title: result?.best?.title || null,
        },
        cooldownMs: 12 * 60 * 60 * 1000,
      });
    }

    return res.status(200).json({
      ok: true,
      query: result?.query || query,
      bestPrice: result?.bestPrice ?? null,
      best: result?.best ?? null,
      estValue: finitePrice(result?.bestPrice),
      marketLow: finitePrice(result?.consensus?.typicalLow),
      marketHigh: finitePrice(result?.consensus?.typicalHigh),
      delta: result?.delta ?? null,
      state: result?.state ?? null,
      consensus: result?.consensus ?? buildMarketConsensus([]),
      watchSignals: result?.watchSignals ?? null,
    });
  } catch {
    return res.status(200).json({
      ok: true,
      bestPrice: null,
      best: null,
      estValue: null,
      marketLow: null,
      marketHigh: null,
      delta: null,
      state: null,
      consensus: buildMarketConsensus([]),
      reason: "watch_recheck_failed",
    });
  }
});

function validatePhase1Config() {
  const warnings = [];

  if (IS_PROD && REDIS_REQUIRED_IN_PROD && !process.env.REDIS_URL) {
    warnings.push({
      code: "missing_redis_url",
      reason: "REDIS_URL is required in production for Phase 1 shared-state safety",
    });
  }

  if (REQUIRE_EDGE_SECRET && !EDGE_SHARED_SECRET) {
    warnings.push({
      code: "missing_edge_secret",
      reason: "REQUIRE_EDGE_SECRET=true but EDGE_SHARED_SECRET is empty",
    });
  }

  if (IS_PROD && !OPS_SECRET) {
    warnings.push({
      code: "missing_ops_secret",
      reason: "OPS_SECRET is empty in production",
    });
  }

  if (IS_PROD && !process.env.API_KEY) {
    warnings.push({
      code: "missing_api_key",
      reason: "API_KEY is empty in production",
    });
  }

  return warnings;
}

const phase1ConfigWarnings = validatePhase1Config();

for (const warning of phase1ConfigWarnings) {
  logEvent("warn", "config_warning", warning);
  pushOpsAlert("config_warning", warning, 60 * 60 * 1000);
}

function validatePhase2Config() {
  const warnings = [];

  if (IS_PROD && AUTH_ENABLED && !AUTH_JWT_SECRET) {
    warnings.push({
      code: "missing_auth_jwt_secret",
      reason: "AUTH_ENABLED=true but AUTH_JWT_SECRET is empty in production",
    });
  }

  if (IS_PROD && OBJECT_STORE_PROVIDER !== "s3") {
    warnings.push({
      code: "non_s3_object_store_in_prod",
      reason: "Phase 2 production should use OBJECT_STORE_PROVIDER=s3",
    });
  }

  if (
    OBJECT_STORE_PROVIDER === "s3" &&
    (
      !OBJECT_STORE_BUCKET ||
      !OBJECT_STORE_ACCESS_KEY_ID ||
      !OBJECT_STORE_SECRET_ACCESS_KEY
    )
  ) {
    warnings.push({
      code: "incomplete_s3_object_store_config",
      reason: "OBJECT_STORE_PROVIDER=s3 but bucket/credentials are incomplete",
    });
  }

  return warnings;
}

const phase2ConfigWarnings = validatePhase2Config();

for (const warning of phase2ConfigWarnings) {
  logEvent("warn", "phase2_config_warning", warning);
  pushOpsAlert("phase2_config_warning", warning, 60 * 60 * 1000);
}

app.get("/debug/queues", async (_req, res) => {
  try {
    const topics = Object.keys(QUEUE_WORKER_CONCURRENCY);
    const stats = {};

    for (const topic of topics) {
      stats[topic] = await queueTopicStats(topic);
    }

    return res.status(200).json({
      ok: true,
      enabled: QUEUE_ENABLED,
      backend: redis ? "redis" : "local",
      namespace: QUEUE_NAMESPACE,
      visibilityTimeoutMs: QUEUE_VISIBILITY_TIMEOUT_MS,
      maxAttempts: QUEUE_MAX_ATTEMPTS,
      workers: QUEUE_WORKER_CONCURRENCY,
      stats,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "queue_debug_failed",
      reason: err?.message || String(err),
    });
  }
});

app.get("/debug/queues/job/:jobId", async (req, res) => {
  try {
    const jobId = safeStr(req.params?.jobId, 120);
    const job = await readQueueJobDoc(jobId);

    return res.status(200).json({
      ok: !!job,
      job: job || null,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "queue_job_debug_failed",
      reason: err?.message || String(err),
    });
  }
});

app.post("/debug/queues/retry-dead", async (req, res) => {
  try {
    const jobId = safeStr(req.body?.jobId, 120);
    if (!jobId) {
      return res.status(200).json({
        ok: false,
        error: "missing_job_id",
      });
    }

    const job = await readQueueJobDoc(jobId);
    if (!job) {
      return res.status(200).json({
        ok: false,
        error: "job_not_found",
      });
    }

    const topic = job.topic || queueTopicForType(job.type);

    if (redis) {
      await redisCommand(["LREM", queueKey(topic, "dead"), "1", jobId]);
    } else {
      const dead = localQueueBucket(LOCAL_QUEUE_STATE.dead, topic);
      const idx = dead.indexOf(jobId);
      if (idx >= 0) dead.splice(idx, 1);
    }

    job.status = "queued";
    job.updatedAt = Date.now();
    job.nextRunAt = Date.now();
    await saveQueueJobDoc(job);
    await pushPendingJobId(topic, jobId);

    return res.status(200).json({
      ok: true,
      jobId,
      topic,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "retry_dead_failed",
      reason: err?.message || String(err),
    });
  }
});
function validatePhase3Config() {
  const warnings = [];

  if (QUEUE_ENABLED && !redis) {
    warnings.push({
      code: "queue_running_without_redis",
      reason: "Phase 3 is enabled but Redis is missing, so queue falls back to local memory only.",
    });
  }

  if (QUEUE_ENABLED && Number(QUEUE_MAX_ATTEMPTS || 0) < 2) {
    warnings.push({
      code: "queue_max_attempts_too_low",
      reason: "QUEUE_MAX_ATTEMPTS should usually be at least 2 for retry behavior.",
    });
  }

  if (QUEUE_ENABLED && Number(QUEUE_VISIBILITY_TIMEOUT_MS || 0) < 15000) {
    warnings.push({
      code: "queue_visibility_timeout_too_low",
      reason: "QUEUE_VISIBILITY_TIMEOUT_MS is too low for long-running embedding/precompute jobs.",
    });
  }

  return warnings;
}

const phase3ConfigWarnings = validatePhase3Config();

for (const warning of phase3ConfigWarnings) {
  logEvent("warn", "phase3_config_warning", warning);
  pushOpsAlert("phase3_config_warning", warning, 60 * 60 * 1000);
}

app.get("/ops/metrics", requireOpsAccess, async (_req, res) => {
  try {
    return res.status(200).json({
      ok: true,
      snapshot: getPhase5MetricsSnapshot(),
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "ops_metrics_failed",
      reason: err?.message || String(err),
    });
  }
});

app.get("/ops/alerts", requireOpsAccess, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 50)));
    const items = await listOpsAlerts(limit);

    return res.status(200).json({
      ok: true,
      items,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "ops_alerts_failed",
      reason: err?.message || String(err),
    });
  }
});

app.get("/ops/drills", requireOpsAccess, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 50)));
    const items = await listOpsDrills(limit);

    return res.status(200).json({
      ok: true,
      items,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "ops_drills_failed",
      reason: err?.message || String(err),
    });
  }
});

app.post(
  "/admin/backup/restore-drill",
  requireApiKey,
  createIdempotencyMiddleware("backup_restore_drill"),
  async (req, res) => {
    try {
      const label = safeStr(req.body?.label, 40) || "restore_drill";

      const roots = Array.isArray(req.body?.roots) && req.body.roots.length
        ? req.body.roots.map((x) => safeStr(x, 260)).filter(Boolean)
        : [
            "./storage/intelligence",
            "./storage/product-scale",
            "./storage/scan-pipeline",
            "./storage/retrieval-core",
            "./storage/queue",
            "./storage/vector-db",
            "./storage/listings-db",
            "./storage/search-index",
            "./storage/product-graph",
            "./storage/object-store",
            "./storage/hardening",
            "./intelligence-db",
          ];

      const snapshot = await createBackupSnapshot({
        label,
        roots,
      });

      const latest = await listBackupSnapshots(5);

      const drill = await recordOpsDrill("backup_restore", {
        label,
        ok: !!snapshot,
        snapshotLabel: snapshot?.label || null,
        rootCount: roots.length,
      });

      if (!snapshot) {
        await emitOpsAlert(
          "backup_restore_drill_failed",
          {
            label,
            roots,
          },
          { severity: "error" }
        );
      }

      return res.status(200).json({
        ok: !!snapshot,
        drill,
        snapshot: snapshot || null,
        latest,
        note:
          "This verifies snapshot creation/readability from the application layer. Full DB/object-storage restore still must be executed in infrastructure.",
      });
    } catch (err) {
      await emitOpsAlert(
        "backup_restore_drill_failed",
        {
          reason: err?.message || String(err),
        },
        { severity: "error" }
      );

      return res.status(200).json({
        ok: false,
        error: "backup_restore_drill_failed",
        reason: err?.message || String(err),
      });
    }
  }
);

app.post(
  "/admin/global/failover-drill",
  requireApiKey,
  createIdempotencyMiddleware("global_failover_drill"),
  async (req, res) => {
    try {
      const before = getGlobalHealthSnapshot();
      const originalRegion =
        safeStr(before?.activeRegion || DEPLOY_REGION, 60) || DEPLOY_REGION;

      const targetRegion =
        safeStr(req.body?.region, 60) ||
        (originalRegion === PRIMARY_REGION ? DEPLOY_REGION : PRIMARY_REGION) ||
        originalRegion;

      const revert = req.body?.revert !== false;

      const switched = await setActiveRegion(targetRegion, "drill");
      let reverted = null;

      if (revert && originalRegion && originalRegion !== targetRegion) {
        reverted = await setActiveRegion(originalRegion, "drill_revert");
      }

      const drill = await recordOpsDrill("global_failover", {
        originalRegion,
        targetRegion,
        reverted: !!reverted,
      });

      return res.status(200).json({
        ok: true,
        drill,
        originalRegion,
        targetRegion,
        switched,
        reverted,
        health: getGlobalHealthSnapshot(),
      });
    } catch (err) {
      await emitOpsAlert(
        "global_failover_drill_failed",
        {
          reason: err?.message || String(err),
        },
        { severity: "error" }
      );

      return res.status(200).json({
        ok: false,
        error: "global_failover_drill_failed",
        reason: err?.message || String(err),
      });
    }
  }
);


  // -------------------- PORTFOLIO ROUTES --------------------

  app.post("/portfolio/add", async (req, res) => {
    try {
      const userId = safeStr(req.body?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });

      const item = await addPortfolioItem(redis, userId, {
        query:            safeStr(req.body?.query,         220) || null,
        title:            safeStr(req.body?.title,         220) || null,
        brand:            safeStr(req.body?.brand,          80) || null,
        model:            safeStr(req.body?.model,         100) || null,
        category:         safeStr(req.body?.category,       80) || null,
        imageUrl:         safeStr(req.body?.imageUrl,      400) || null,
        imageHash:        safeStr(req.body?.imageHash,     128) || null,
        acquisitionPrice: finitePrice(req.body?.acquisitionPrice),
        currentValue:     finitePrice(req.body?.currentValue),
        conditionGrade:   safeStr(req.body?.conditionGrade, 8)  || null,
        conditionLabel:   safeStr(req.body?.conditionLabel, 60) || null,
        listingStatus:    safeStr(req.body?.listingStatus,  20) || "unlisted",
        platform:         safeStr(req.body?.platform,       60) || null,
        notes:            safeStr(req.body?.notes,         500) || null,
        visionIdentity:   req.body?.visionIdentity || null,
      });

      return res.status(200).json({ ok: true, item });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "portfolio_add_failed", reason: err?.message || String(err) });
    }
  });

  app.get("/portfolio/summary", async (req, res) => {
    try {
      const userId = safeStr(req.query?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const summary = await getPortfolioSummary(redis, userId);
      return res.status(200).json({ ok: true, summary: summary || { totalItems: 0, totalCost: 0, currentValue: 0, unrealizedGain: 0 } });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "portfolio_summary_failed", reason: err?.message || String(err) });
    }
  });

  app.get("/portfolio/items", async (req, res) => {
    try {
      const userId = safeStr(req.query?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const limit  = Math.max(1, Math.min(200, Number(req.query?.limit  || 50)));
      const offset = Math.max(0, Number(req.query?.offset || 0));
      const items  = await listPortfolioItems(redis, userId, limit, offset);
      return res.status(200).json({ ok: true, items });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "portfolio_items_failed", reason: err?.message || String(err) });
    }
  });

  app.post("/portfolio/item/update-value", async (req, res) => {
    try {
      const userId = safeStr(req.body?.userId, 64);
      const itemId = safeStr(req.body?.itemId, 80);
      const value  = finitePrice(req.body?.currentValue);
      if (!userId || !itemId || value == null) return res.status(200).json({ ok: false, error: "missing_fields" });
      const item = await updatePortfolioItemValue(redis, userId, itemId, value);
      return res.status(200).json({ ok: !!item, item: item || null });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "portfolio_update_failed", reason: err?.message || String(err) });
    }
  });

  app.post("/portfolio/item/sold", async (req, res) => {
    try {
      const userId    = safeStr(req.body?.userId, 64);
      const itemId    = safeStr(req.body?.itemId, 80);
      const soldPrice = finitePrice(req.body?.soldPrice);
      const platform  = safeStr(req.body?.platform, 60) || null;
      if (!userId || !itemId) return res.status(200).json({ ok: false, error: "missing_fields" });
      const item = await markPortfolioItemSold(redis, userId, itemId, { soldPrice, platform });
      return res.status(200).json({ ok: !!item, item: item || null });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "portfolio_sold_failed", reason: err?.message || String(err) });
    }
  });

  app.post("/portfolio/item/remove", async (req, res) => {
    try {
      const userId = safeStr(req.body?.userId, 64);
      const itemId = safeStr(req.body?.itemId, 80);
      if (!userId || !itemId) return res.status(200).json({ ok: false, error: "missing_fields" });
      const result = await removePortfolioItem(redis, userId, itemId);
      return res.status(200).json({ ok: true, result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "portfolio_remove_failed", reason: err?.message || String(err) });
    }
  });

  app.get("/portfolio/performance", async (req, res) => {
    try {
      const userId = safeStr(req.query?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const perf = await getPortfolioPerformance(redis, userId);
      return res.status(200).json({ ok: true, performance: perf || null });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "portfolio_perf_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- AUTOPILOT ROUTES --------------------

  app.get("/autopilot/recommendations", async (req, res) => {
    try {
      const userId = safeStr(req.query?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const data = await getAutopilotRecommendations(redis, userId);
      return res.status(200).json({
        ok:              true,
        recommendations: data?.recommendations || [],
        updatedAt:       data?.updatedAt       || null,
      });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "autopilot_get_failed", reason: err?.message || String(err) });
    }
  });

  app.post("/autopilot/run", async (req, res) => {
    try {
      const userId = safeStr(req.body?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const jobId = queueAutopilotRun(userId);
      return res.status(200).json({ ok: true, queued: true, jobId });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "autopilot_run_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- SCAN REPLAY ROUTES --------------------

  app.get("/scan/replay/:scanId", async (req, res) => {
    try {
      const scanId = safeStr(req.params?.scanId, 128);
      if (!scanId) return res.status(200).json({ ok: false, error: "missing_scan_id" });
      const replay = await getScanReplay(redis, scanId);
      return res.status(200).json({ ok: !!replay, replay: replay || null });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "scan_replay_get_failed", reason: err?.message || String(err) });
    }
  });

  app.post("/scan/replay/outcome", async (req, res) => {
    try {
      const scanId  = safeStr(req.body?.scanId,  128);
      const outcome = safeStr(req.body?.outcome,  40);
      const meta    = req.body?.meta || {};
      if (!scanId || !outcome) return res.status(200).json({ ok: false, error: "missing_fields" });
      const record = await markScanOutcome(redis, scanId, outcome, meta);
      return res.status(200).json({ ok: !!record, record: record || null });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "scan_outcome_failed", reason: err?.message || String(err) });
    }
  });

  app.get("/scan/history", async (req, res) => {
    try {
      const userId = safeStr(req.query?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const limit  = Math.max(1, Math.min(100, Number(req.query?.limit || 50)));
      const items  = await getUserScanReplays(redis, userId, limit);
      return res.status(200).json({ ok: true, items });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "scan_history_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- COUNTERFACTUAL RESULT ROUTE --------------------

  app.get("/vision/counterfactual/:imageHash", async (req, res) => {
    try {
      const imageHash = safeStr(req.params?.imageHash, 128);
      if (!imageHash) return res.status(200).json({ ok: false, error: "missing_hash" });
      const raw = await cacheGet(`counterfactual:${imageHash}`);
      return res.status(200).json({
        ok:     !!raw,
        result: raw || null,
        ready:  !!raw,
      });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "counterfactual_get_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- SUBSTITUTE INTEL (standalone) --------------------

  // POST /intel/substitute
  // Body: { identity, uiItems, scannedPrice, category }
  app.post("/intel/substitute", async (req, res) => {
    try {
      const { identity = {}, uiItems = [], scannedPrice = null, category = "" } = req.body || {};
      const result = buildSubstituteIntelPayload({ identity, uiItems, scannedPrice, category });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "substitute_intel_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- CHEAPER ALTERNATIVE (standalone) --------------------

  // POST /intel/cheaper-alternative
  // Body: { identity, scannedPrice, uiItems, category }
  app.post("/intel/cheaper-alternative", async (req, res) => {
    try {
      const { identity = {}, scannedPrice = null, uiItems = [], category = "" } = req.body || {};
      const budgetAlt  = findBudgetAlternative(identity, category, scannedPrice);
      const valueScore = scorePremiumVsValue(identity, scannedPrice, uiItems);
      const substituteIntel = buildSubstituteIntelPayload({ identity, uiItems, scannedPrice, category });
      const dontBuyThis = buildDontBuyThisPayload({ identity, scannedPrice, uiItems, category, substituteIntel });
      return res.status(200).json({ ok: true, budgetAlternative: budgetAlt || null, valueScore: valueScore || null, dontBuyThis });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "cheaper_alt_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- ARBITRAGE INTEL (standalone) --------------------

  // POST /intel/arbitrage
  // Body: { uiItems, scannedPrice, category, consensus }
  app.post("/intel/arbitrage", async (req, res) => {
    try {
      const { uiItems = [], scannedPrice = null, category = "", consensus = null } = req.body || {};
      const result = buildArbitrageIntelPayload({ uiItems, scannedPrice, category, consensus });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "arbitrage_intel_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- DEAL COMPARATOR (standalone) --------------------

  // POST /intel/deal-compare
  // Body: { scannedPrice, uiItems, consensus, category, identity }
  app.post("/intel/deal-compare", async (req, res) => {
    try {
      const { scannedPrice = null, uiItems = [], consensus = null, category = "", identity = null } = req.body || {};
      const result = buildDealComparatorPayload({ scannedPrice, uiItems, consensus, category, identity });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "deal_compare_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- DNA MATCH ENGINE (standalone) --------------------

  // POST /intel/dna-match
  // Body: { primaryItem, primaryPrice, candidates, scannedPrice }
  app.post("/intel/dna-match", async (req, res) => {
    try {
      const { primaryItem = {}, primaryPrice = null, candidates = [], scannedPrice = null } = req.body || {};
      const result = buildDNAMatchPayload({ primaryItem, primaryPrice, candidates, scannedPrice });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "dna_match_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- PRICE ANOMALY DETECTOR (standalone) --------------------

  // POST /intel/price-anomaly
  // Body: { scannedPrice, uiItems }
  app.post("/intel/price-anomaly", async (req, res) => {
    try {
      const { scannedPrice = null, uiItems = [] } = req.body || {};
      const result = buildPriceAnomalyPayload({ scannedPrice, uiItems });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "price_anomaly_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- VALUE DEPRECIATION CURVE (standalone) --------------------

  // POST /intel/depreciation
  // Body: { identity, category, currentPrice, conditionLabel, medianMarket }
  app.post("/intel/depreciation", async (req, res) => {
    try {
      const { identity = {}, category = "", currentPrice = null, conditionLabel = "", medianMarket = null } = req.body || {};
      const result = buildValueDepreciationCurve({ identity, category, currentPrice, conditionLabel, medianMarket });
      return res.status(200).json({ ok: true, result: result || null });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "depreciation_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- QUERY ARBITRAGE ENGINE (standalone) --------------------

  // POST /intel/query-arbitrage
  // Body: { identity, category, uiItems }
  app.post("/intel/query-arbitrage", async (req, res) => {
    try {
      const { identity = {}, category = "", uiItems = [] } = req.body || {};
      const result = buildQueryArbitragePayload({ identity, category, uiItems });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "query_arbitrage_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- PROFIT CALCULATOR (standalone) --------------------

  // POST /intel/profit
  // Body: { buyPrice, scannedPrice, medianMarket, category, platforms, includeTax }
  app.post("/intel/profit", async (req, res) => {
    try {
      const { buyPrice = null, scannedPrice = null, medianMarket = null, category = "", platforms, includeTax = false } = req.body || {};
      const result = buildProfitCalculatorPayload({ buyPrice, scannedPrice, medianMarket, category, platforms, includeTax });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "profit_calc_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- IMAGE CONTEXT (standalone) --------------------

  // POST /intel/image-context
  // Body: { visibleText, styleWords, visionConfidence }
  app.post("/intel/image-context", async (req, res) => {
    try {
      const { visibleText = [], styleWords = [], visionConfidence = 0.5 } = req.body || {};
      const result = buildImageContextPayload({ visibleText, styleWords, visionConfidence });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "image_context_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- WATCHLIST (Redis-backed) --------------------

  // POST /watchlist/add
  app.post("/watchlist/add", async (req, res) => {
    try {
      const userId = safeStr(req.body?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const result = await addToWatchlist(redis, userId, req.body || {});
      return res.status(200).json({ ok: !!result, item: result || null });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "watchlist_add_failed", reason: err?.message || String(err) });
    }
  });

  // DELETE /watchlist/remove
  app.post("/watchlist/remove", async (req, res) => {
    try {
      const userId = safeStr(req.body?.userId, 64);
      const itemId = safeStr(req.body?.itemId, 128);
      if (!userId || !itemId) return res.status(200).json({ ok: false, error: "missing_fields" });
      const ok = await removeFromWatchlist(redis, userId, itemId);
      return res.status(200).json({ ok });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "watchlist_remove_failed", reason: err?.message || String(err) });
    }
  });

  // GET /watchlist/list?userId=...&limit=...
  app.get("/watchlist/list", async (req, res) => {
    try {
      const userId = safeStr(req.query?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const limit = Math.max(1, Math.min(100, Number(req.query?.limit || 50)));
      const items = await listWatchlistItems(redis, userId, limit);
      return res.status(200).json({ ok: true, items });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "watchlist_list_failed", reason: err?.message || String(err) });
    }
  });

  // GET /watchlist/price-history?fingerprint=...
  app.get("/watchlist/price-history", async (req, res) => {
    try {
      const fp = safeStr(req.query?.fingerprint, 128);
      if (!fp) return res.status(200).json({ ok: false, error: "missing_fingerprint" });
      const history = await getWatchlistPriceHistory(redis, fp);
      return res.status(200).json({ ok: true, fingerprint: fp, history });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "watchlist_history_failed", reason: err?.message || String(err) });
    }
  });

  // GET /watchlist/alerts?userId=...
  app.get("/watchlist/alerts", async (req, res) => {
    try {
      const userId = safeStr(req.query?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const alerts = await checkWatchlistAlerts(redis, userId, {});
      return res.status(200).json({ ok: true, alerts });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "watchlist_alerts_failed", reason: err?.message || String(err) });
    }
  });

  // GET /watchlist/demand?brand=...&model=...&category=...
  app.get("/watchlist/demand", async (req, res) => {
    try {
      const identity = {
        brand:    safeStr(req.query?.brand,    64),
        model:    safeStr(req.query?.model,    64),
        category: safeStr(req.query?.category, 40),
      };
      const result = await buildWatchlistDemandSignal(redis, identity, identity.category);
      return res.status(200).json({ ok: true, demand: result || null });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "watchlist_demand_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- EVAN SUMMARY (standalone) --------------------

  // POST /intel/evan-summary
  // Body: any combination of intel payloads (pass the full scan response body)
  app.post("/intel/evan-summary", async (req, res) => {
    try {
      const result = buildEvanSummary(req.body || {});
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "evan_summary_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- RISK SCORE (standalone) --------------------

  // POST /intel/risk-score
  // Body: { authenticityIntel, conditionPricing, dealComparator, demandSignals, trendIntel, scannedPrice }
  app.post("/intel/risk-score", async (req, res) => {
    try {
      const { authenticityIntel = null, conditionPricing = null, dealComparator = null, demandSignals = null, trendIntel = null, scannedPrice = null } = req.body || {};
      const result = buildRiskScorePayload({ authenticityIntel, conditionPricing, dealComparator, demandSignals, trendIntel, scannedPrice });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "risk_score_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- SELLER PROFILE (standalone) --------------------

  // POST /intel/seller-profile
  // Body: { feedbackCount, feedbackPct, isPowerSeller, isTopRated, noReturns, onlyStockPhotos,
  //         descriptionEmpty, brandName, listingPrice, brandPriceFloor, accountAgeDays }
  app.post("/intel/seller-profile", async (req, res) => {
    try {
      const sellerData = req.body || {};
      const result = buildSellerProfilePayload(sellerData);
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "seller_profile_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- CATEGORY-SPECIFIC INTEL (standalone) --------------------

  // POST /intel/category
  // Body: { identity, category, uiItems, visibleText }
  app.post("/intel/category", async (req, res) => {
    try {
      const { identity = {}, category = "", uiItems = [], visibleText = [] } = req.body || {};
      const result = buildCategorySpecificIntel({ identity, category, uiItems, visibleText });
      return res.status(200).json({ ok: true, result: result || null, available: !!result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "category_intel_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- SMART ALERTS (standalone) --------------------

  // POST /intel/alerts
  // Body: { dealComparator, authenticityIntel, arbitrageIntel, trendIntel, demandSignals,
  //         conditionPricing, substituteIntel, priceHistoryIntel, identity, scannedPrice }
  app.post("/intel/alerts", async (req, res) => {
    try {
      const { identity = {}, scannedPrice = null, ...intelPayloads } = req.body || {};
      const result = buildSmartAlertPayload({ ...intelPayloads, identity, scannedPrice });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "smart_alerts_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- PRICE HISTORY INTELLIGENCE (standalone) --------------------

  // POST /intel/price-history
  // Body: { scannedPrice, uiItems, consensus, category }
  app.post("/intel/price-history", async (req, res) => {
    try {
      const { scannedPrice = null, uiItems = [], consensus = null, category = "" } = req.body || {};
      const result = buildPriceHistoryIntelPayload({ scannedPrice, uiItems, consensus, category });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "price_history_intel_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- CONDITION PRICING ADJUSTER (standalone) --------------------

  // POST /intel/condition-pricing
  // Body: { listingPrice, conditionLabel, newMarketPrice, medianMarket, category }
  app.post("/intel/condition-pricing", async (req, res) => {
    try {
      const { listingPrice = null, conditionLabel = "", newMarketPrice = null, medianMarket = null, category = "" } = req.body || {};
      const result = buildConditionPricingPayload({ listingPrice, conditionLabel, newMarketPrice, medianMarket, category });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "condition_pricing_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- DEMAND SIGNALS (standalone) --------------------

  // POST /intel/demand
  // Body: { uiItems, category }
  app.post("/intel/demand", async (req, res) => {
    try {
      const { uiItems = [], category = "" } = req.body || {};
      const result = buildDemandSignalPayload({ uiItems, category });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "demand_signals_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- NEGOTIATION INTELLIGENCE (standalone) --------------------

  // POST /intel/negotiate
  // Body: { listingPrice, marketMedian, dealVerdict, identity, daysListed, hasPriceDrops, isBestOffer }
  app.post("/intel/negotiate", async (req, res) => {
    try {
      const {
        listingPrice = null, marketMedian = null, dealVerdict = "fair",
        identity = {}, daysListed = null, hasPriceDrops = false,
        isBestOffer = false, hasMultipleItems = false,
      } = req.body || {};
      const result = buildNegotiationIntelPayload({
        listingPrice, marketMedian, dealVerdict, identity,
        daysListed, hasPriceDrops, isBestOffer, hasMultipleItems,
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "negotiation_intel_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- TREND INTELLIGENCE (standalone) --------------------

  // POST /intel/trend
  // Body: { identity, category, scannedPrice, uiItems, consensus }
  app.post("/intel/trend", async (req, res) => {
    try {
      const { identity = {}, category = "", scannedPrice = null, uiItems = [], consensus = null } = req.body || {};
      const result = buildTrendIntelPayload({ identity, category, scannedPrice, uiItems, consensus });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "trend_intel_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- AUTHENTICITY INTELLIGENCE (standalone) --------------------

  // POST /intel/authenticity
  // Body: { identity, scannedPrice, category, visionConfidence }
  app.post("/intel/authenticity", async (req, res) => {
    try {
      const { identity = {}, scannedPrice = null, category = "", visionConfidence = 0.5 } = req.body || {};
      const result = buildAuthenticityIntelPayload({ identity, scannedPrice, category, visionConfidence });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "authenticity_intel_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- RESALE OPTIMIZER (standalone) --------------------

  // POST /intel/resale-optimizer
  // Body: { identity, category, scannedPrice, medianMarket, conditionLabel, liquidityTier }
  app.post("/intel/resale-optimizer", async (req, res) => {
    try {
      const { identity = {}, category = "", scannedPrice = null, medianMarket = null, conditionLabel = "", liquidityTier = "moderate", isLuxury = false } = req.body || {};
      const result = buildResaleOptimizerPayload({ identity, category, scannedPrice, medianMarket, conditionLabel, liquidityTier, isLuxury });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "resale_optimizer_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- BUNDLE INTELLIGENCE (standalone) --------------------

  // POST /intel/bundle
  // Body: { identity, category, scannedPrice, medianMarket }
  app.post("/intel/bundle", async (req, res) => {
    try {
      const { identity = {}, category = "", scannedPrice = null, medianMarket = null } = req.body || {};
      const result = buildBundleIntelPayload({ identity, category, scannedPrice, medianMarket });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "bundle_intel_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- SIZE ARBITRAGE ENGINE (standalone) --------------------

  // POST /intel/size-arbitrage
  // Body: { identity, uiItems, size }
  app.post("/intel/size-arbitrage", async (req, res) => {
    try {
      const { identity = {}, uiItems = [], size = "" } = req.body || {};
      const result = buildSizeArbitragePayload({ identity, uiItems, size });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "size_arbitrage_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- COLORWAY SUBSTITUTE ENGINE (standalone) --------------------

  // POST /intel/colorway-substitutes
  // Body: { identity, scannedPrice, uiItems }
  app.post("/intel/colorway-substitutes", async (req, res) => {
    try {
      const { identity = {}, scannedPrice = null, uiItems = [] } = req.body || {};
      const result = buildColorwaySubstitutePayload({ identity, scannedPrice, uiItems });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "colorway_substitutes_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- RELEASE CALENDAR INTELLIGENCE (standalone) --------------------

  // POST /intel/release-calendar
  // Body: { identity, scannedPrice, medianMarket }
  app.post("/intel/release-calendar", async (req, res) => {
    try {
      const { identity = {}, scannedPrice = null, medianMarket = null } = req.body || {};
      const result = buildReleaseCalendarPayload({ identity, scannedPrice, medianMarket });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "release_calendar_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- ITEM CONDITION FORENSICS (standalone) --------------------

  // POST /intel/condition-forensics
  // Body: { visibleText, styleWords, category, scannedPrice, medianMarket }
  app.post("/intel/condition-forensics", async (req, res) => {
    try {
      const { visibleText = [], styleWords = [], category = "", scannedPrice = null, medianMarket = null } = req.body || {};
      const result = buildConditionForensicsPayload({ visibleText, styleWords, category, scannedPrice, medianMarket });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "condition_forensics_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- ALTERNATIVE MARKETPLACE RADAR (standalone) --------------------

  // POST /intel/alt-marketplaces
  // Body: { identity, category, scannedPrice, medianMarket }
  app.post("/intel/alt-marketplaces", async (req, res) => {
    try {
      const { identity = {}, category = "", scannedPrice = null, medianMarket = null } = req.body || {};
      const result = buildAlternativeMarketplacePayload({ identity, category, scannedPrice, medianMarket });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "alt_marketplaces_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- CROSS-LISTING DEDUPLICATOR (standalone) --------------------

  // POST /intel/dedup
  // Body: { uiItems, category }
  app.post("/intel/dedup", async (req, res) => {
    try {
      const { uiItems = [], category = "" } = req.body || {};
      const result = buildCrossListingDeduplicatorPayload({ uiItems, category });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "dedup_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- FAKE LISTING DETECTOR (standalone) --------------------

  // POST /intel/fake-detector
  // Body: { title, description, scannedPrice, medianMarket, category, sellerFeedback,
  //         sellerIsNew, noReturns, stockPhotoOnly, paymentMethod, visionConfidence, uiItems }
  app.post("/intel/fake-detector", async (req, res) => {
    try {
      const {
        title = "", description = "", scannedPrice = null, medianMarket = null,
        category = "", sellerFeedback = null, sellerIsNew = false, noReturns = false,
        stockPhotoOnly = false, paymentMethod = "", visionConfidence = null, uiItems = [],
      } = req.body || {};
      const result = buildFakeListingDetectorPayload({
        title, description, scannedPrice, medianMarket, category,
        sellerFeedback, sellerIsNew, noReturns, stockPhotoOnly,
        paymentMethod, visionConfidence, uiItems,
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "fake_detector_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- SEASONAL FLIP CALENDAR (standalone) --------------------

  // POST /intel/seasonal-flip
  // Body: { category, currentMonth, scannedPrice, medianMarket }
  app.post("/intel/seasonal-flip", async (req, res) => {
    try {
      const { category = "", currentMonth = null, scannedPrice = null, medianMarket = null } = req.body || {};
      const result = buildSeasonalFlipCalendarPayload({ category, currentMonth, scannedPrice, medianMarket });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "seasonal_flip_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- BRAND TIER CLASSIFIER (standalone) --------------------

  // POST /intel/brand-tier
  // Body: { identity, category, scannedPrice, medianMarket }
  app.post("/intel/brand-tier", async (req, res) => {
    try {
      const { identity = {}, category = "", scannedPrice = null, medianMarket = null } = req.body || {};
      const result = buildBrandTierPayload({ identity, category, scannedPrice, medianMarket });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "brand_tier_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- SMART PRICE TARGET ENGINE (standalone) --------------------

  // POST /intel/price-targets
  // Body: { scannedPrice, medianMarket, dealVerdict, demandSignals, conditionPricing,
  //         depreciationCurve, category, profitTarget }
  app.post("/intel/price-targets", async (req, res) => {
    try {
      const {
        scannedPrice = null, medianMarket = null, dealVerdict = null,
        demandSignals = null, conditionPricing = null, depreciationCurve = null,
        category = "", profitTarget = 20,
      } = req.body || {};
      const result = buildSmartPriceTargetPayload({
        scannedPrice, medianMarket, dealVerdict, demandSignals,
        conditionPricing, depreciationCurve, category, profitTarget,
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "price_targets_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- LISTING QUALITY SCORER (standalone) --------------------

  // POST /intel/listing-quality
  // Body: { title, description, category, scannedPrice, medianMarket, dealVerdict,
  //         photoCount, hasMultiAngle, stockPhotoOnly, hasDefectPhoto, lightingQuality,
  //         sellerProfile, identity }
  app.post("/intel/listing-quality", async (req, res) => {
    try {
      const {
        title = "", description = "", category = "", scannedPrice = null,
        medianMarket = null, dealVerdict = null, photoCount = 0,
        hasMultiAngle = false, stockPhotoOnly = false, hasDefectPhoto = false,
        lightingQuality = null, sellerProfile = {}, identity = {},
      } = req.body || {};
      const result = buildListingQualityScorerPayload({
        title, description, category, scannedPrice, medianMarket, dealVerdict,
        photoCount, hasMultiAngle, stockPhotoOnly, hasDefectPhoto,
        lightingQuality, sellerProfile, identity,
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "listing_quality_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- MARKET MOMENTUM TRACKER (standalone) --------------------

  // POST /intel/momentum
  // Body: { uiItems, soldItems, category }
  app.post("/intel/momentum", async (req, res) => {
    try {
      const { uiItems = [], soldItems = [], category = "" } = req.body || {};
      const result = buildMarketMomentumPayload({ uiItems, soldItems, category });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "momentum_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- FLIP SCORE ENGINE (standalone) --------------------

  // POST /intel/flip-score
  // Body: { priceTargets, profitCalc, demandSignals, marketMomentum, riskScore,
  //         fakeDetector, authenticityIntel, dealComparator, seasonalFlip, trendIntel }
  app.post("/intel/flip-score", async (req, res) => {
    try {
      const result = buildFlipScorePayload(req.body || {});
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "flip_score_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- SCAN-TO-LIST PIPELINE (standalone) --------------------

  // POST /intel/scan-to-list
  // Body: { identity, category, scannedPrice, medianMarket, conditionForensics,
  //         conditionPricing, resaleOptimizer }
  app.post("/intel/scan-to-list", async (req, res) => {
    try {
      const { identity = {}, category = "", scannedPrice = null, medianMarket = null,
              conditionForensics = null, conditionPricing = null, resaleOptimizer = null } = req.body || {};
      const result = buildScanToListPayload({ identity, category, scannedPrice, medianMarket,
                                              conditionForensics, conditionPricing, resaleOptimizer });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "scan_to_list_failed", reason: err?.message || String(err) });
    }
  });

  // POST /intel/scan-to-list/:platform
  // Body: { identity, category, scannedPrice, medianMarket, conditionForensics, conditionImpact }
  app.post("/intel/scan-to-list/:platform", async (req, res) => {
    try {
      const platform = safeStr(req.params?.platform, 20).toLowerCase();
      const { identity = {}, category = "", scannedPrice = null, medianMarket = null,
              conditionForensics = null, conditionImpact = 0 } = req.body || {};
      const result = generatePlatformListing(platform, { identity, category,
        scannedPrice: finitePrice(scannedPrice), medianMarket: finitePrice(medianMarket),
        conditionForensics, conditionImpact });
      if (!result) return res.status(200).json({ ok: false, error: "unknown_platform" });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "platform_listing_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- DEAL LEDGER (Redis-backed) --------------------

  // POST /ledger/log
  // Body: { userId, itemId, itemTitle, category, scannedPrice, medianMarket, dealVerdict,
  //         netSavings, flipProfit, brand, model }
  app.post("/ledger/log", async (req, res) => {
    try {
      const { userId, ...scanData } = req.body || {};
      const uid = safeStr(userId, 64);
      if (!uid) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const result = await buildDealLedgerPayload(redis, uid, scanData);
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "ledger_log_failed", reason: err?.message || String(err) });
    }
  });

  // GET /ledger/summary?userId=...
  app.get("/ledger/summary", async (req, res) => {
    try {
      const userId = safeStr(req.query?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const summary = await getLedgerSummary(redis, userId);
      return res.status(200).json({ ok: true, summary });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "ledger_summary_failed", reason: err?.message || String(err) });
    }
  });

  // GET /ledger/scans?userId=...&limit=...
  app.get("/ledger/scans", async (req, res) => {
    try {
      const userId = safeStr(req.query?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 20)));
      const scans  = await getRecentScans(redis, userId, limit);
      return res.status(200).json({ ok: true, scans });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "ledger_scans_failed", reason: err?.message || String(err) });
    }
  });

  // GET /ledger/leaderboard?limit=...
  app.get("/ledger/leaderboard", async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 10)));
      const board  = await getLeaderboard(redis, limit);
      return res.status(200).json({ ok: true, leaderboard: board });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "leaderboard_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- COMPARATIVE BUY DECISION (standalone) --------------------

  // POST /intel/compare
  // Body: { itemA: <full scan result>, itemB: <full scan result>, labelA, labelB }
  app.post("/intel/compare", async (req, res) => {
    try {
      const { itemA = {}, itemB = {}, labelA = "Item A", labelB = "Item B" } = req.body || {};
      const result = buildComparativeBuyDecisionPayload({ itemA, itemB, labelA, labelB });
      if (!result) return res.status(200).json({ ok: false, error: "comparison_requires_both_items" });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "comparison_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- RESALE SPEED PREDICTOR (standalone) --------------------

  // POST /intel/resale-speed
  // Body: { category, demandSignals, dealComparator, conditionPricing, marketMomentum }
  app.post("/intel/resale-speed", async (req, res) => {
    try {
      const { category = "", demandSignals = null, dealComparator = null,
              conditionPricing = null, marketMomentum = null } = req.body || {};
      const result = buildResaleSpeedPayload({ category, demandSignals, dealComparator,
                                               conditionPricing, marketMomentum });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "resale_speed_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- MARKET DEPTH ANALYZER (standalone) --------------------

  // POST /intel/market-depth
  // Body: { uiItems, soldItems, category }
  app.post("/intel/market-depth", async (req, res) => {
    try {
      const { uiItems = [], soldItems = [], category = "" } = req.body || {};
      const result = buildMarketDepthPayload({ uiItems, soldItems, category });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "market_depth_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- EVAN INTEL PULSE (Redis-backed) --------------------

  // GET /pulse/digest?userId=...
  app.get("/pulse/digest", async (req, res) => {
    try {
      const userId = safeStr(req.query?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const result = await buildEvanIntelPulsePayload(redis, userId);
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "pulse_failed", reason: err?.message || String(err) });
    }
  });

  // POST /pulse/config
  // Body: { userId, categories, minDealPct }
  app.post("/pulse/config", async (req, res) => {
    try {
      const { userId, categories = [], minDealPct = 10 } = req.body || {};
      const uid = safeStr(userId, 64);
      if (!uid) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const result = await setPulseConfig(redis, uid, { categories, minDealPct });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "pulse_config_failed", reason: err?.message || String(err) });
    }
  });

  // POST /pulse/evaluate
  // Body: { userId, ...fullScanResult }
  // Called after a scan completes — evaluates and pushes pulse events
  app.post("/pulse/evaluate", async (req, res) => {
    try {
      const { userId, ...scanResult } = req.body || {};
      const uid = safeStr(userId, 64);
      if (!uid) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const events = await evaluateScanForPulse(redis, uid, scanResult);
      return res.status(200).json({ ok: true, events, eventCount: events.length });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "pulse_evaluate_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- SMART SUBSTITUTE RANKER (standalone) --------------------

  // POST /intel/substitutes
  // Body: { scannedPrice, medianMarket, dnaMatch, colorwaySubstitutes, brandTier, altMarketplaces }
  app.post("/intel/substitutes", async (req, res) => {
    try {
      const { scannedPrice = null, medianMarket = null, dnaMatch = null,
              colorwaySubstitutes = null, brandTier = null, altMarketplaces = null } = req.body || {};
      const result = buildSmartSubstituteRankerPayload({ scannedPrice, medianMarket, dnaMatch, colorwaySubstitutes, brandTier, altMarketplaces });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "substitutes_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- PRICE PREDICTION MODEL (standalone) --------------------

  // POST /intel/price-prediction
  // Body: { scannedPrice, medianMarket, category, depreciationCurve, marketMomentum, trendIntel }
  app.post("/intel/price-prediction", async (req, res) => {
    try {
      const { scannedPrice = null, medianMarket = null, category = "",
              depreciationCurve = null, marketMomentum = null, trendIntel = null } = req.body || {};
      const result = buildPricePredictionPayload({ scannedPrice, medianMarket, category, depreciationCurve, marketMomentum, trendIntel });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "price_prediction_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- AUTHENTICATION SERVICE ROUTER (standalone) --------------------

  // POST /intel/auth-route
  // Body: { identity, category, scannedPrice, medianMarket, authenticityIntel }
  app.post("/intel/auth-route", async (req, res) => {
    try {
      const { identity = {}, category = "", scannedPrice = null,
              medianMarket = null, authenticityIntel = null } = req.body || {};
      const result = buildAuthServiceRouterPayload({ identity, category, scannedPrice, medianMarket, authenticityIntel });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "auth_route_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- COUNTEROFFER SCRIPT BUILDER (standalone) --------------------

  // POST /intel/counteroffer
  // Body: { scannedPrice, medianMarket, dealVerdict, negotiationIntel, conditionForensics }
  app.post("/intel/counteroffer", async (req, res) => {
    try {
      const { scannedPrice = null, medianMarket = null, dealVerdict = "fair",
              negotiationIntel = null, conditionForensics = null } = req.body || {};
      const result = buildCounteroferScriptPayload({ scannedPrice, medianMarket, dealVerdict, negotiationIntel, conditionForensics });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "counteroffer_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- EVAN SCORE EXPLAINER (standalone) --------------------

  // POST /intel/explain
  // Body: full scan result (or any subset of intel fields)
  app.post("/intel/explain", async (req, res) => {
    try {
      const result = buildEvanScoreExplainerPayload(req.body || {});
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "explainer_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- BUY OR PASS ENGINE (Feature 62) --------------------

  // POST /intel/buy-or-pass
  // Body: full scan result bundle (all or subset of intel fields)
  // Returns: verdict (BUY/PASS/WAIT/STRONG_BUY/CAUTION), confidence 0-100, one-line reason, signals
  app.post("/intel/buy-or-pass", async (req, res) => {
    try {
      const result = buildBuyOrPassPayload(req.body || {});
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "buy_or_pass_failed", reason: err?.message || String(err) });
    }
  });

  // ── Feature 63: Barcode / UPC Lookup ─────────────────────────────────────
  // POST /intel/barcode
  // Body: { barcode?: string, visibleText?: string[] }
  // Returns: product identity from UPC database (brand, model, MSRP, specs)
  app.post("/intel/barcode", async (req, res) => {
    try {
      const result = await buildBarcodeIntelligencePayload({
        visibleText: Array.isArray(req.body?.visibleText) ? req.body.visibleText : [],
        barcode:     safeStr(req.body?.barcode, 32) || null,
        redis,
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "barcode_lookup_failed", reason: err?.message || String(err) });
    }
  });

  // GET /intel/barcode/:upc
  // Returns: product data for a specific UPC
  app.get("/intel/barcode/:upc", async (req, res) => {
    try {
      const upc = safeStr(req.params?.upc, 20)?.replace(/\D/g, "");
      if (!upc) return res.status(200).json({ ok: false, error: "missing_upc" });
      const result = await buildBarcodeIntelligencePayload({ barcode: upc, redis });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "barcode_lookup_failed", reason: err?.message || String(err) });
    }
  });

  // ── Feature 64: Multi-Angle Consensus ────────────────────────────────────
  // POST /intel/multi-angle
  // Body: { passes: VisionResult[] } — array of 2-4 vision pass results
  // Returns: merged consensus identity, conflict flags, agreement scores
  app.post("/intel/multi-angle", async (req, res) => {
    try {
      const passes = Array.isArray(req.body?.passes) ? req.body.passes : [];
      if (passes.length < 2) return res.status(200).json({ ok: false, error: "need_at_least_2_passes" });
      const result = buildMultiAngleConsensusPayload(passes);
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "multi_angle_failed", reason: err?.message || String(err) });
    }
  });

  // ── Feature 65: Box Tag Extractor ────────────────────────────────────────
  // POST /intel/box-tag
  // Body: { visibleText: string[], identity?: object, query?: string }
  // Returns: styleCode, colorway, size, msrp, enhancedQuery
  app.post("/intel/box-tag", async (req, res) => {
    try {
      const result = buildBoxTagPayload({
        visibleText: Array.isArray(req.body?.visibleText) ? req.body.visibleText : [],
        identity:    req.body?.identity || {},
        query:       safeStr(req.body?.query, 220) || null,
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "box_tag_failed", reason: err?.message || String(err) });
    }
  });

  // ── Feature 66: Seller Jargon Normalizer ─────────────────────────────────
  // POST /intel/normalize-query
  // Body: { query: string, variants?: string[] }
  // Returns: normalized query, extracted condition/size/colorway/model data
  app.post("/intel/normalize-query", async (req, res) => {
    try {
      const result = buildSellerJargonPayload({
        query:    safeStr(req.body?.query, 300) || "",
        variants: Array.isArray(req.body?.variants) ? req.body.variants : [],
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "normalize_query_failed", reason: err?.message || String(err) });
    }
  });

  // ── Feature 67: Logo Confidence Scorer ───────────────────────────────────
  // POST /intel/logo-confidence
  // Body: full vision result (identity, visibleText, authenticityFlags, etc.)
  // Returns: per-brand confidence scores with evidence breakdown
  app.post("/intel/logo-confidence", async (req, res) => {
    try {
      const result = buildLogoConfidencePayload(req.body || {});
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "logo_confidence_failed", reason: err?.message || String(err) });
    }
  });

  // ── Feature 68: Seal / Tag / Sticker Detector ─────────────────────────────
  // POST /intel/seal-tags
  // Body: { visibleText, styleWords, conditionFlags, title, description, category, currentCondition, basePrice }
  app.post("/intel/seal-tags", async (req, res) => {
    try {
      const result = buildSealTagPayload(req.body || {});
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "seal_tags_failed", reason: err?.message || String(err) });
    }
  });

  // ── Feature 69: Counterfeit Visual Diff ───────────────────────────────────
  // POST /intel/counterfeit-diff
  // Body: { brand, authenticityFlags, visibleText, styleWords, conditionFlags, scannedPrice, medianMarket, visionConfidence }
  app.post("/intel/counterfeit-diff", async (req, res) => {
    try {
      const result = autoRunVisualDiff(req.body || {});
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "counterfeit_diff_failed", reason: err?.message || String(err) });
    }
  });

  // ── Feature 70: Sold Comps Date Filter ────────────────────────────────────
  // POST /intel/sold-comps-date
  // Body: { items: [...] }  — pass raw market items array
  app.post("/intel/sold-comps-date", async (req, res) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const result = buildSoldCompsDateFilterPayload(items);
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "sold_comps_date_failed", reason: err?.message || String(err) });
    }
  });

  // ── Feature 71+72: Premium Price Sources (StockX / GOAT / Poshmark / Depop) ─
  // POST /intel/premium-prices
  // Body: { query, category }
  app.post("/intel/premium-prices", async (req, res) => {
    try {
      if (!SERPAPI_KEY) return res.status(200).json({ ok: false, error: "serp_not_configured" });
      const query    = safeStr(req.body?.query, 220);
      const category = safeStr(req.body?.category, 80) || null;
      if (!query) return res.status(200).json({ ok: false, error: "missing_query" });
      const result = await buildPremiumPriceSourcesPayload({ query, serpKey: SERPAPI_KEY, category });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "premium_prices_failed", reason: err?.message || String(err) });
    }
  });

  // ── Feature 73: Price Floor Tracker ───────────────────────────────────────
  // GET /intel/price-floor?query=...
  app.get("/intel/price-floor", async (req, res) => {
    try {
      const query = normalizeQuery(safeStr(req.query?.q || req.query?.query, 220));
      if (!query) return res.status(200).json({ ok: false, error: "missing_query" });
      const floorResult = await getPriceFloor(query, redis);
      return res.status(200).json({ ok: true, query, priceFloor: floorResult });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "price_floor_failed", reason: err?.message || String(err) });
    }
  });

  // ── Feature 74: Price Alert Webhooks ─────────────────────────────────────
  // POST /alerts/webhook/register
  // Body: { userId, webhookUrl, events }
  app.post("/alerts/webhook/register", async (req, res) => {
    try {
      const userId     = safeStr(req.body?.userId, 64);
      const webhookUrl = safeStr(req.body?.webhookUrl || req.body?.url, 500);
      const events     = Array.isArray(req.body?.events) ? req.body.events : ["price_alert"];
      if (!userId || !webhookUrl) return res.status(200).json({ ok: false, error: "missing_fields" });
      const result = await registerWebhook(userId, webhookUrl, { events, redis });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "webhook_register_failed", reason: err?.message || String(err) });
    }
  });

  // DELETE /alerts/webhook?userId=...
  app.delete("/alerts/webhook", async (req, res) => {
    try {
      const userId = safeStr(req.query?.userId || req.body?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      await unregisterWebhook(userId, redis);
      return res.status(200).json({ ok: true, userId });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "webhook_delete_failed", reason: err?.message || String(err) });
    }
  });

  // GET /alerts/webhook?userId=...
  app.get("/alerts/webhook", async (req, res) => {
    try {
      const userId = safeStr(req.query?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const config = await getWebhookConfig(userId, redis);
      return res.status(200).json({ ok: true, userId, config });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "webhook_get_failed", reason: err?.message || String(err) });
    }
  });

  // POST /alerts/check
  // Body: { userId, watchlistItem: { id, query, title, targetPrice }, currentPrice, marketData? }
  app.post("/alerts/check", async (req, res) => {
    try {
      const userId        = safeStr(req.body?.userId, 64);
      const watchlistItem = req.body?.watchlistItem || null;
      const currentPrice  = finitePrice(req.body?.currentPrice);
      const marketData    = req.body?.marketData || null;
      if (!userId || !watchlistItem || !currentPrice) {
        return res.status(200).json({ ok: false, error: "missing_fields" });
      }
      const result = await buildPriceAlertPayload({ userId, watchlistItem, currentPrice, marketData, redis });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "alert_check_failed", reason: err?.message || String(err) });
    }
  });

  // ── Feature 75: Condition Tier Pricer ─────────────────────────────────────
  // POST /intel/condition-tiers
  // Body: { items: [...], currentCondition? }
  app.post("/intel/condition-tiers", async (req, res) => {
    try {
      const items            = Array.isArray(req.body?.items) ? req.body.items : [];
      const currentCondition = safeStr(req.body?.currentCondition, 40) || null;
      const result = buildConditionTierPayload(items, currentCondition);
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "condition_tiers_failed", reason: err?.message || String(err) });
    }
  });

  // ── Feature 76: Regional Price Variance ───────────────────────────────────
  // POST /intel/regional-prices
  // Body: { query, category?, regions?: ["us","uk","eu","jp"] }
  app.post("/intel/regional-prices", async (req, res) => {
    try {
      if (!SERPAPI_KEY) return res.status(200).json({ ok: false, error: "serp_not_configured" });
      const query    = safeStr(req.body?.query, 220);
      const category = safeStr(req.body?.category, 80) || null;
      const regions  = Array.isArray(req.body?.regions) ? req.body.regions : null;
      if (!query) return res.status(200).json({ ok: false, error: "missing_query" });
      const result = await buildRegionalPricePayload({ query, serpKey: SERPAPI_KEY, category, regions });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "regional_prices_failed", reason: err?.message || String(err) });
    }
  });

  // ── Feature 77: Lot / Bundle Detector ─────────────────────────────────────
  // POST /intel/lot-bundle
  // Body: { items: [...], singleUnitMedian?, category? }
  app.post("/intel/lot-bundle", async (req, res) => {
    try {
      const items           = Array.isArray(req.body?.items) ? req.body.items : [];
      const singleUnitMedian = finitePrice(req.body?.singleUnitMedian) || null;
      const category        = safeStr(req.body?.category, 80) || null;
      const result = buildLotBundlePayload(items, { singleUnitMedian, category });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "lot_bundle_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- PORTFOLIO TRACKER (Redis-backed) --------------------

  // POST /portfolio/add
  // Body: { userId, itemId, title, brand, model, category, purchasePrice, condition, size, platform, notes }
  app.post("/portfolio/add", async (req, res) => {
    try {
      const userId = safeStr(req.body?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const result = await addTrackerPortfolioItem(redis, userId, req.body || {});
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "portfolio_add_failed", reason: err?.message || String(err) });
    }
  });

  // POST /portfolio/remove
  // Body: { userId, itemId }
  app.post("/portfolio/remove", async (req, res) => {
    try {
      const userId = safeStr(req.body?.userId, 64);
      const itemId = safeStr(req.body?.itemId, 128);
      if (!userId || !itemId) return res.status(200).json({ ok: false, error: "missing_fields" });
      const ok = await removeTrackerPortfolioItem(redis, userId, itemId);
      return res.status(200).json({ ok });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "portfolio_remove_failed", reason: err?.message || String(err) });
    }
  });

  // GET /portfolio?userId=...
  app.get("/portfolio", async (req, res) => {
    try {
      const userId = safeStr(req.query?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const result = await buildPortfolioPayload(redis, userId);
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "portfolio_failed", reason: err?.message || String(err) });
    }
  });

  // POST /portfolio/price
  // Body: { userId, itemId, currentMarketPrice }
  app.post("/portfolio/price", async (req, res) => {
    try {
      const userId = safeStr(req.body?.userId, 64);
      const itemId = safeStr(req.body?.itemId, 128);
      const price  = finitePrice(req.body?.currentMarketPrice);
      if (!userId || !itemId) return res.status(200).json({ ok: false, error: "missing_fields" });
      const result = await updatePortfolioItemPrice(redis, userId, itemId, price);
      return res.status(200).json({ ok: !!result, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "portfolio_price_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- THRIFT SCANNER MODE (Redis-backed) --------------------

  // POST /thrift/start
  // Body: { userId, location, budget }
  app.post("/thrift/start", async (req, res) => {
    try {
      const userId = safeStr(req.body?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const result = await startThriftSession(redis, userId, req.body || {});
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "thrift_start_failed", reason: err?.message || String(err) });
    }
  });

  // POST /thrift/scan
  // Body: { sessionId, ...fullScanResult }
  app.post("/thrift/scan", async (req, res) => {
    try {
      const sessionId = safeStr(req.body?.sessionId, 128);
      if (!sessionId) return res.status(200).json({ ok: false, error: "missing_session_id" });
      const result = await addSessionScan(redis, sessionId, req.body || {});
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "thrift_scan_failed", reason: err?.message || String(err) });
    }
  });

  // GET /thrift/summary?sessionId=...
  app.get("/thrift/summary", async (req, res) => {
    try {
      const sessionId = safeStr(req.query?.sessionId, 128);
      if (!sessionId) return res.status(200).json({ ok: false, error: "missing_session_id" });
      const summary = await getSessionSummary(redis, sessionId);
      return res.status(200).json({ ok: !!summary, summary });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "thrift_summary_failed", reason: err?.message || String(err) });
    }
  });

  // POST /thrift/end
  // Body: { sessionId }
  app.post("/thrift/end", async (req, res) => {
    try {
      const sessionId = safeStr(req.body?.sessionId, 128);
      if (!sessionId) return res.status(200).json({ ok: false, error: "missing_session_id" });
      const result = await endThriftSession(redis, sessionId);
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "thrift_end_failed", reason: err?.message || String(err) });
    }
  });

  // GET /thrift/sessions?userId=...
  app.get("/thrift/sessions", async (req, res) => {
    try {
      const userId = safeStr(req.query?.userId, 64);
      if (!userId) return res.status(200).json({ ok: false, error: "missing_user_id" });
      const sessions = await getUserSessions(redis, userId);
      return res.status(200).json({ ok: true, sessions });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "thrift_sessions_failed", reason: err?.message || String(err) });
    }
  });

  // -------------------- Start + graceful shutdown --------------------
  const server = app.listen(PORT, HOST, () => {
  logEvent("info", "server_started", {
    host: HOST,
    port: PORT,
    instanceId: INSTANCE_ID,
    openaiEnabled: !!OPENAI_API_KEY,
    redisEnabled: !!redis,
    marketSources: {
      ebay: hasEbayApi(),
      walmart: hasWalmartApi(),
      bestbuy: hasBestBuyApi(),
      etsy: hasEtsyApi(),
      serpapiLegacy: !!SERPAPI_KEY,
    },
  });

  if (!OPENAI_API_KEY) {
    pushOpsAlert(
      "openai_missing",
      {
        reason: "OPENAI_API_KEY missing (Vision disabled)",
      },
      60 * 60 * 1000
    );
  }
});

leaderElection.start();

let leaderLoopsStarted = false;

function startLeaderOnlyLoops() {
  if (leaderLoopsStarted || !shouldRunSchedulers()) return;

  leaderLoopsStarted = true;

  startInternalMarketRefreshLoop();
  console.log(
    "🧠 Phase 4 internal retrieval refresh loop running every",
    INTERNAL_MARKET_REFRESH_INTERVAL_MS,
    "ms"
  );

  startCrawlerExpansionLoop();
  console.log("🕸️ Phase 4 crawler loop running every", CRAWLER_INTERVAL_MS, "ms");

  startPrecomputeLoop();
  console.log("⚡ Phase 5 precompute loop running every", PRECOMPUTE_INTERVAL_MS, "ms");

  startBackupLoop(
    [
      "./storage/intelligence",
      "./storage/product-scale",
      "./storage/scan-pipeline",
      "./storage/retrieval-core",
      "./storage/queue",
      "./storage/vector-db",
      "./storage/listings-db",
      "./storage/search-index",
      "./storage/product-graph",
      "./storage/object-store",
      "./intelligence-db",
    ],
    Number(process.env.HARDENING_BACKUP_INTERVAL_MS || 6 * 60 * 60 * 1000)
  );

  console.log(
    "💾 Phase 6 backup loop running every",
    Number(process.env.HARDENING_BACKUP_INTERVAL_MS || 6 * 60 * 60 * 1000),
    "ms"
  );

  startGlobalResilienceLoop();
  console.log(
    "🌍 Phase 7 resilience loop running every",
    Number(process.env.GLOBAL_RESILIENCE_INTERVAL_MS || 30_000),
    "ms"
  );

  startGlobalReplicationLoop([
    "./storage/intelligence",
    "./storage/product-scale",
    "./storage/scan-pipeline",
    "./storage/retrieval-core",
    "./storage/queue",
    "./storage/vector-db",
    "./storage/listings-db",
    "./storage/search-index",
    "./storage/product-graph",
    "./storage/object-store",
    "./storage/hardening",
    "./intelligence-db",
  ]);

  console.log(
    "🔁 Phase 7 replication loop running every",
    Number(process.env.GLOBAL_REPLICATION_INTERVAL_MS || 15 * 60 * 1000),
    "ms"
  );
}

setInterval(() => {
  if (shouldRunSchedulers()) {
    startLeaderOnlyLoops();
  }
}, 2000).unref?.();

if (shouldRunQueueWorkers()) {
  startQueueBackboneWorkers();
  console.log("🧵 Phase 3 queue backbone running", {
    enabled: QUEUE_ENABLED,
    backend: redis ? "redis" : "local",
    namespace: QUEUE_NAMESPACE,
    workers: QUEUE_WORKER_CONCURRENCY,
    role: SERVER_ROLE,
  });
}

startLeaderOnlyLoops();

server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 5000);
server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 65000);
server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
server.maxRequestsPerSocket = Number(process.env.MAX_REQUESTS_PER_SOCKET || 1000);

function shutdown(sig) {
  console.log(`🛑 ${sig} received. Shutting down...`);

  try {
    leaderElection.stop();
  } catch {}

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.on("clientError", (err, socket) => {
  console.warn("CLIENT ERROR:", err?.message || err);

  try {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {}
});

process.on("warning", (warning) => {
  console.warn("PROCESS WARNING:", {
    name: warning?.name || "warning",
    message: warning?.message || String(warning),
    stack: warning?.stack || null,
  });

  Promise.resolve()
    .then(() =>
      emitOpsAlert(
        "process_warning",
        {
          name: warning?.name || "warning",
          message: warning?.message || String(warning),
        },
        { severity: "warn", skipRedis: true, cooldownMs: 60_000 }
      )
    )
    .catch(() => {});
});

// -------------------- Crash protection --------------------
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
  recordHardeningEvent("unhandled_rejection", {
    error: err?.message || String(err),
  });
  incrementMetric("process_unhandled_rejection_total", {});
  Promise.resolve()
    .then(() =>
      emitOpsAlert(
        "unhandled_rejection",
        {
          error: err?.message || String(err),
        },
        { severity: "error", skipRedis: true, cooldownMs: 30_000 }
      )
    )
    .catch(() => {})
    .finally(() => {
      if (IS_PROD) shutdown("UNHANDLED_REJECTION");
    });
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  recordHardeningEvent("uncaught_exception", {
    error: err?.message || String(err),
  });
  incrementMetric("process_uncaught_exception_total", {});
  Promise.resolve()
    .then(() =>
      emitOpsAlert(
        "uncaught_exception",
        {
          error: err?.message || String(err),
        },
        { severity: "error", skipRedis: true, cooldownMs: 30_000 }
      )
    )
    .catch(() => {})
    .finally(() => {
      shutdown("UNCAUGHT_EXCEPTION");
    });
});

setInterval(() => {
  const used = process.memoryUsage().heapUsed / 1024 / 1024;

  if (used > 700) {
    console.warn("⚠️ High memory usage detected:", used.toFixed(1), "MB");
    incrementMetric("high_memory_total", {});

    Promise.resolve()
      .then(() =>
        emitOpsAlert(
          "high_memory",
          {
            heapUsedMb: Number(used.toFixed(1)),
          },
          { severity: "warn", cooldownMs: 60_000, skipRedis: true }
        )
      )
      .catch(() => {});

    visionCache.prune(0.5);
    SERP_CACHE.prune(0.5);
    RESEARCH_CACHE.prune(0.5);
    LOCAL_CACHE.prune(0.5);
  }
}, 30000);
