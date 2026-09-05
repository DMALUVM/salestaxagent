/**
 * THIS WEEK: Blake Recovery Sep 5 — 66-row ranked execute list.
 *
 * Authoritative CSV is embedded below (header + 66 data rows). Do not
 * invent or alter numbers. 63d / 24d lists stay libraries. Bleeders 1.0
 * stays secondary triage. Recommend-only — nothing writes to Amazon.
 *
 * Order: cuts (R1 → R2 → P1 → HOLD), SCALE/DEFEND, GROW, then L7
 * head-term R2 surgery (ids 63–66).
 */

import {
  WEEKLY_ACTIONS,
  WEEKLY_CADENCE,
  WEEKLY_GROK_PROMPT_RECOVERY_0905,
  WEEKLY_HOLD,
  WEEKLY_LOCK_DAYS,
  applyWeeklyLocks,
  type WeeklyAction,
  type WeeklyLockDecision,
  type WeeklyPayload,
  type WeeklyRow,
  type WeeklyWindow,
} from "./ppc-weekly";
import {
  resolveNamedCampaign,
  type BlakeLookup,
  type WeeklyCampaignRef,
  type WeeklyPlacementRef,
  type WeeklyTermRef,
} from "./ppc-weekly-blake-24d";

export type { BlakeLookup, WeeklyCampaignRef, WeeklyPlacementRef, WeeklyTermRef };

export const BLAKE_RECOVERY_0905_START = "2026-07-06";
export const BLAKE_RECOVERY_0905_END = "2026-09-04";
export const BLAKE_RECOVERY_0905_DAYS = 61;
export const BLAKE_RECOVERY_0905_ROW_COUNT = 66;
export const BLAKE_RECOVERY_0905_WINDOW_LABEL = "2026-07-06..09-04 (~60d ST)";
export const BLAKE_RECOVERY_0905_WINDOW_CHIP = "Recovery Sep 5 · 66 rows";
export const BLAKE_RECOVERY_0905_L7 = "2026-08-29..09-04 L7";
export const BLAKE_RECOVERY_0905_PLACEMENT_LABEL = "2026-08-06..09-04 (~30d placement)";
export const BLAKE_RECOVERY_0905_BE = 37.9;
export const BLAKE_RECOVERY_0905_CLICK_FLOOR = 6;
export const BLAKE_RECOVERY_0905_LANE = {
  branded: 41,
  nonbrand: 26,
} as const;

/** Authoritative Recovery CSV (header + 66 data rows). */
export const RECOVERY_0905_CSV: string = "id,rank,action,campaign,ad_group,term,match_type,clicks,spend,sales,term_cvr,account_cvr_lane,acos,current_bid,new_bid,placement,window,why\n1,R1,pause_keyword,GG - Deodorant - Exact - SQR - CST,Exact,deodorant men,EXACT,96,113.18,0,0%,nonbrand ~26%,,,,,2026-07-06..09-04 ~60d ST,\"Bleeders 1.0: exact KW = term, 96 clicks $0. Pause keyword only.\"\n2,R1,pause_keyword,GG - SP - KW - Tallow Balm - B0CLF5B27Y - Exact 4,Exact,beef tallow moisturizer,EXACT,31,59.4,0,0%,nonbrand ~26%,,,,,2026-07-06..09-04 ~60d ST,Bleeders 1.0 exact KW $0.\n3,R1,negative_exact,GG - Lip Balm - Asin Offense - Lip Balm Category,Asin Offense,dr dans cortibalm lip balm,TARGETING_EXPRESSION,32,58.55,0,0%,nonbrand ~26%,,,,,2026-07-06..09-04 ~60d ST,Competitor query $0 on offense. Neg Exact the search term.\n4,R1,negative_exact,GG - Lip Balm - Broad M,Broad,all natural chapstick,BROAD,15,39.69,0,0%,nonbrand ~26%,,,,,2026-08-29..09-04 L7,L7 Command Brief P0 #1. Fresh zero-order waste.\n5,R1,negative_exact,GG - Lip Balm - Exact - ChapStick related,Exact,chapstick natural,EXACT,10,38.89,0,0%,nonbrand ~26%,,,,,2026-08-29..09-04 L7,L7 P0 #2. If KW equals term pause instead of neg.\n6,R1,negative_exact,SP | TBL - 3Pck | B0CLHTKY3V |  Auto | Loose Match-TOS | SSG,SP | TBL - 3Pck | B0CLHTKY3V |  Auto | Loose Match | SSG,eos lip balm,TARGETING_EXPRESSION_PREDEFINED,18,34.72,0,0%,nonbrand ~26%,,,,,2026-08-29..09-04 L7,L7 P0 #3 Auto Loose waste.\n7,R1,negative_exact,SP - ASIN - COMP - Exact - Tallow Deodorant - B0CLHYY3BB -,B0CLHYY3BB,b0f7zfzd9z,TARGETING_EXPRESSION,16,31.36,0,0%,nonbrand ~26%,,,,,2026-08-29..09-04 L7,L7 P0 #4. Competitor ASIN query still $0 this week (60d had 1 order at 912% ACOS \u2014 treat as cut).\n8,R1,negative_exact,SP | TBL - 3Pck | B0CLHTKY3V |  Auto | Loose Match-TOS | SSG,SP | TBL - 3Pck | B0CLHTKY3V |  Auto | Loose Match | SSG,aquaphor lip balm,TARGETING_EXPRESSION_PREDEFINED,16,31.06,0,0%,nonbrand ~26%,,,,,2026-08-29..09-04 L7,L7 P0 #5.\n9,R1,negative_exact,GG - Lip Balm - Broad M,Broad,coconut oil lip balm,BROAD,23,46.47,0,0%,nonbrand ~26%,,,,,2026-07-06..09-04 ~60d ST,60d + L7 Broad waste. Neg Exact.\n10,R1,negative_exact,GG - Deodorant - Exact - Low Volume,Exact,vanmans deodorant,EXACT,38,42.78,0,0%,nonbrand ~26%,,,,,2026-07-06..09-04 ~60d ST,Query \u2260 KW spelling. Neg Exact vanmans deodorant.\n11,R1,negative_exact,SP - KW - Exact - Tallow Balm - B0CLF5B27Y - MAG,B0CLF5B27Y,beef tallow and honey balm,EXACT,24,42.37,0,0%,nonbrand ~26%,,,,,2026-07-06..09-04 ~60d ST,Bleeders 1.0.\n12,R1,negative_exact,SP - Auto - Deodorant - B0CLHYY3BB -,B0CLHYY3BB,wild deodorant,TARGETING_EXPRESSION_PREDEFINED,35,31.18,0,0%,nonbrand ~26%,,,,,2026-07-06..09-04 ~60d ST,Close-match Auto $0.\n13,R1,negative_exact,GG - Lip Balm - Exact - ChapStick related,Exact,best chapstick,EXACT,7,23.09,0,0%,nonbrand ~26%,,,,,2026-08-29..09-04 L7,\"L7 P0 #6. Also 60d ACOS 201% with sales \u2014 do not harvest; after neg, consider pause_keyword best chapstick if it is the exact KW.\"\n14,R1,negative_exact,GG - Lip Balm - Broad M,Broad,shea butter chapstick,BROAD,9,22.41,0,0%,nonbrand ~26%,,,,,2026-08-29..09-04 L7,L7 P0 #8.\n15,R1,negative_exact,GG - Deodorant - Asin Offense 1,Asin Offense,carpe deodorant,TARGETING_EXPRESSION,20,20.6,0,0%,nonbrand ~26%,,,,,2026-08-29..09-04 L7,L7 P0 #10. Offense 1 only \u2014 Asin Defense carpe already applied Aug 20.\n16,R2,bid_down,SP KW - Exact(PM) - Lip Balm - DPB0CLHTKY3V/B0CLHVLG2F -,SP | TBL - 3Pck | lip balm-keywords | Exact | NonBranded | SSG,organic lip balm,EXACT,891,1616.45,2804.51,22%,nonbrand ~26%,57.6%,,live CPC \u00d7 0.38 / 0.576,,2026-07-06..09-04 ~60d ST,Biggest ACOS hole with sales. NEVER pause. Bid down ~34% toward BE. Recheck 7d.\n17,R2,bid_down,GG - Lip Balm - Asin Offense - Lip Balm Category,Asin Offense,B00EXPRM7C,TARGETING_EXPRESSION,445,726.24,1259.1,19.8%,nonbrand ~26%,57.7%,,live CPC \u00d7 0.38 / 0.577,,2026-07-06..09-04 ~60d ST,\"Offense ASIN over BE. Bid down, do not harvest.\"\n18,R2,bid_down,GG - Lip Balm - Asin Offense - Lip Balm Category,Asin Offense,B07XXPHQZK,TARGETING_EXPRESSION,470,662.66,1175.16,17.9%,nonbrand ~26%,56.4%,,live CPC \u00d7 0.38 / 0.564,,2026-07-06..09-04 ~60d ST,Same.\n19,R2,bid_down,GG - Deodorant - Asin Offense 3,Asin Offense,B08WYXNVQ7,TARGETING_EXPRESSION,305,334.83,461.71,9.2%,nonbrand ~26%,72.5%,,live CPC \u00d7 0.38 / 0.725,,2026-07-06..09-04 ~60d ST,ACOS>55% AND CVR<17% = classic Bleeders 2.0. Bid down hard.\n20,R2,bid_down,GG - Deodorant - Asin Offense 3,Asin Offense,B09YK5F5NC,TARGETING_EXPRESSION,314,420.04,701.56,13.7%,nonbrand ~26%,59.9%,,live CPC \u00d7 0.38 / 0.599,,2026-07-06..09-04 ~60d ST,Bleeders 2.0 filter.\n21,R2,bid_down,SP - 1KW(900kSV/ROS-PP) - Exact - Lip Balm - B0CLHTKY3V - -lip balm organic,B0CLHTKY3V,lip balm organic,EXACT,102,292.21,335.76,23.5%,nonbrand ~26%,87.0%,,live CPC \u00d7 0.38 / 0.870,,2026-07-06..09-04 ~60d ST,87% ACOS Exact. Bid down; never pause organic/lip balm organic winners family.\n22,R2,bid_down,GG - Lip Balm - Exact - Tallow Balm related KW - TOS,Exact,tallow and honey balm,EXACT,278,288.88,335.76,8.3%,nonbrand ~26%,86.0%,,live CPC \u00d7 0.38 / 0.860,,2026-07-06..09-04 ~60d ST,Low CVR + high ACOS Exact.\n23,R2,bid_down,GG - Lip Balm - Exact - Untargeted,Exact,lip moisturizer for very dry lips,EXACT,102,187.53,195.86,13.7%,nonbrand ~26%,95.7%,,live CPC \u00d7 0.38 / 0.957,,2026-07-06..09-04 ~60d ST,Was a 24d $0; now converts at 96% ACOS \u2014 bid_down not pause.\n24,R2,bid_down,GG - Lip Balm - Broad M,Broad,(campaign-level),BROAD,166,345.72,556.91,22.9%,nonbrand ~26%,62.1%,,lower default bid ~30% OR cut DP first,,2026-08-29..09-04 L7,L7 #1 worst campaign ACOS 62% on $346. Prefer DP cut + negatives first; then lower Broad default bid.\n25,R2,bid_down,SP | TBL - 3Pck | B0CLHTKY3V |  Auto | Loose Match-TOS | SSG,SP | TBL - 3Pck | B0CLHTKY3V |  Auto | Loose Match | SSG,loose-match,TARGETING_EXPRESSION_PREDEFINED,388,735.11,1456.29,25.8%,nonbrand ~26%,50.5%,,live CPC \u00d7 0.38 / 0.505,,2026-08-29..09-04 L7,Largest L7 spend campaign at 50.5% ACOS + huge zero-order tail. Bid down Loose Match; keep harvesting winners out.\n26,P1,cut_detail_page,SP - Auto - AUD (High-Interest) - Catch All - Mixed -,-,-,-,83,72.6,13.99,1.2%,nonbrand ~26%,518.9%,,,Detail Page \u2192 0% or \u2212100%,2026-08-06..09-04 ~30d placement,DP ACOS 519%. Cut product-pages modifier only.\n27,P1,cut_detail_page,SP - 1KW(900kSV/ROS-PP) - Exact - Lip Balm - B0CLHTKY3V - -lip balm organic,-,-,-,15,45.28,27.98,13.3%,nonbrand ~26%,161.8%,,,Detail Page \u2192 0% or \u2212100%,2026-08-06..09-04 ~30d placement,DP 162% ACOS.\n28,P1,cut_detail_page,GG - Lip Balm - Broad M,-,-,-,34,35.59,27.98,5.9%,nonbrand ~26%,127.2%,,,Detail Page \u2192 0% or \u2212100%,2026-08-06..09-04 ~30d placement,DP 127% on Broad M.\n29,P1,cut_detail_page,Catch All - Added To Cart - AMC - TOS,-,-,-,50,38.01,27.98,4.0%,nonbrand ~26%,135.8%,,,Detail Page \u2192 0% or \u2212100%,2026-08-06..09-04 ~30d placement,Also check Catch Alll typo twin campaign.\n30,P1,cut_detail_page,SP - ASIN - COMP - Exact - Tallow Deodorant - B0CLHYY3BB -,-,-,-,32,55.35,47.97,9.4%,nonbrand ~26%,115.4%,,,Detail Page \u2192 0% or \u2212100%,2026-08-06..09-04 ~30d placement,DP 115%.\n31,P1,cut_detail_page,SP - KW (TOS) - Exact - Tallow Lip Balm KW,-,-,-,162,263.55,438.69,19.8%,nonbrand ~26%,60.1%,,,Detail Page \u2192 reduce (do not touch TOS),2026-08-06..09-04 ~30d placement,Biggest DP $ on a core Exact campaign. Trim DP only; TOS on this campaign is the cash engine (60d tallow lip balm ~34% ACOS).\n32,HOLD,hold_tos,SP - Hero KW(256KsV/TOS) -  Exact - Lip Balm - 3 Pack - B0CLHTKY3V/B0CLHV3V5C - -chapstick,-,-,-,95,259.64,487.66,33.7%,nonbrand ~26%,53.2%,,,Top of Search \u2014 DO NOT RAISE,2026-08-29..09-04 L7,L7 Hero Exact still 53% ACOS. No TOS raise. Optional small bid_down on chapstick Exact only after P0/P1.\n33,SCALE,bid_up,SP - Exact - Lip Balm - B0CLHTKY3V - chap stick,B0CLHTKY3V,chap stick,EXACT,268,450.93,1734.76,46.3%,nonbrand ~26%,26.0%,,+15% (only after P0\u2013P1 done),,2026-07-06..09-04 ~60d ST,\"Well under BE, high CVR. Scale AFTER waste cuts. Rank gate may cap \u2014 check organic.\"\n34,SCALE,bid_up,GG - Lip Balm - Exact - SQR - Long/Low,Exact,peppermint chapstick,EXACT,92,203.25,813.45,54.3%,nonbrand ~26%,25.0%,,+15% after P0\u2013P1,,2026-07-06..09-04 ~60d ST,25% ACOS Exact winner.\n35,SCALE,bid_up,SP - KW (TOS) - Exact - Tallow Lip Balm KW,SP | TBL - 3Pck | B0CLHTKY3V | KT | EX | Non-Branded | KW Harvest 04-24-24| SSG,beef tallow for lips,EXACT,124,263.58,908.65,52.4%,nonbrand ~26%,29.0%,,+15% after P0\u2013P1,,2026-07-06..09-04 ~60d ST,Under BE Exact. Do not raise TOS account-wide.\n36,DEFEND,brand_defense,SP - 1Branded KW(TOS) - Exact - Lip Balm - Mixed - -28ord,B0CLHVCPL5,tallowbourne lip balm,EXACT,97,171.32,733.48,51.5%,branded ~41%,23.4%,,hold or +8% max,,2026-07-06..09-04 ~60d ST,Brand defense. Do not cut. Brief: brand only ~2% of ST spend \u2014 underspend not overspend.\n37,GROW,harvest_exact,SP | TBL - 3Pck | B0CLHTKY3V |  Auto | Loose Match-TOS | SSG,SOURCE: Auto Loose \u2192 DEST: Exact harvest AG (not Auto),beef tallow lip balm,EXACT (add),126,204.7,839.4,46.8%,nonbrand ~26%,24.4%,,start near live CPC on converting Exact peers,,2026-07-06..09-04 ~60d ST,\"GNO harvest: Auto Loose winner under BE. Add Exact in harvest/exact AG, then Negative Exact in Auto Loose so you stop paying discovery CPC.\"\n38,GROW,harvest_exact,SP | TBL - 3Pck | B0CLHTKY3V |  Auto | Loose Match-TOS | SSG,SOURCE: Auto Loose \u2192 DEST: Exact harvest AG,sky and sol lip jelly,EXACT (add),68,114.4,531.62,47.1%,nonbrand ~26%,21.5%,,start medium Exact bid,,2026-07-06..09-04 ~60d ST,Auto Loose converter 21.5% ACOS. Harvest Exact then neg from Auto.\n39,GROW,harvest_exact,SP | TBL - 3Pck | B0CLHTKY3V |  Auto | Loose Match-TOS | SSG,SOURCE: Auto Loose \u2192 DEST: Exact harvest AG,non toxic lip balm,EXACT (add),61,111.29,360.75,41.0%,nonbrand ~26%,30.8%,,start medium Exact bid,,2026-07-06..09-04 ~60d ST,Under BE Auto winner. Harvest Exact.\n40,GROW,harvest_exact,SP | TBL - 3Pck | B0CLHTKY3V |  Auto | Loose Match-TOS | SSG,SOURCE: Auto Loose \u2192 DEST: Exact harvest AG,all natural lip balm,EXACT (add),36,72.44,237.83,47.2%,nonbrand ~26%,30.5%,,start medium Exact bid,,2026-07-06..09-04 ~60d ST,Harvest Exact. Do NOT confuse with all natural chapstick (that is a $0 cut).\n41,GROW,harvest_exact,SP 1KW(3kSV) - Broad(TOS/30%) - Lip Balm - B0CLHTKY3V - -organic chapstick,SOURCE: Broad \u2192 DEST: Exact AG for organic chapstick,organic chapstick,EXACT (add),104,163.16,489.65,33.7%,nonbrand ~26%,33.3%,,match peer Exact organic chapstick bid,,2026-07-06..09-04 ~60d ST,Broad converting under BE. Move to Exact; Neg Exact in Broad. You already have an Exact organic chapstick campaign \u2014 prefer bid_up there and Neg Exact this query out of Broad.\n42,GROW,harvest_exact,SP - KW Phrase (PM) - Lip balm - B0CLHTKY3V/B0CLHVCPL5 - -DP,SOURCE: Phrase \u2192 DEST: Exact harvest,grass fed beef tallow lip balm,EXACT (add),22,42.55,269.3,45.5%,nonbrand ~26%,15.8%,,start medium Exact bid,,2026-07-06..09-04 ~60d ST,Phrase winner 15.8% ACOS. Harvest Exact then Neg Exact in Phrase.\n43,GROW,harvest_exact,GG - Lip Balm - Broad M,SOURCE: Broad \u2192 DEST: Exact (chapstick / tallow lip balm owners),chapstick,EXACT (own in Hero Exact \u2014 Neg Exact here),57,74.64,419.7,52.6%,nonbrand ~26%,17.8%,,n/a \u2014 consolidate,,2026-07-06..09-04 ~60d ST,\"Broad converts chapstick at 17.8% but Hero Exact already owns chapstick. Neg Exact chapstick out of Broad so Exact owns volume (growth via cheaper Exact CPC, not more Broad).\"\n44,GROW,harvest_exact,GG - B0CLHYY3BB - Deodorant - Asin Defense,DEST: Exact deodorant KW campaign (not Auto),beef tallow deodorant,EXACT (add),51,131.17,527.67,64.7%,nonbrand ~26%,24.9%,,start medium Exact bid,,2026-07-06..09-04 ~60d ST,Defense PT converting this query \u2014 harvest into Exact deodorant KW; keep defense ASIN running.\n45,GROW,bid_up,SP - Exact - Lip Balm - B0CLHTKY3V - chap stick,B0CLHTKY3V,chap stick,EXACT,268,450.93,1734.76,46.3%,nonbrand ~26%,26.0%,,+15%,,2026-07-06..09-04 ~60d ST,L30 campaign 27.9% ACOS. Scale Exact winner. Do after A-block cuts same day is OK for under-BE Exact.\n46,GROW,bid_up,GG - Lip Balm - Exact - SQR - Long/Low,Exact,peppermint chapstick,EXACT,92,203.25,813.45,54.3%,nonbrand ~26%,25.0%,,+15%,,2026-07-06..09-04 ~60d ST,25% ACOS Exact. Budget only $13 avg \u2014 pair with budget_up.\n47,GROW,bid_up,SP - KW (TOS) - Exact - Tallow Lip Balm KW,Exact harvest AG,beef tallow for lips,EXACT,124,263.58,908.65,52.4%,nonbrand ~26%,29.0%,,+15%,,2026-07-06..09-04 ~60d ST,Under BE Exact on the cash campaign.\n48,GROW,bid_up,SP - KW (TOS) - Exact - Tallow Lip Balm KW,Exact harvest AG,tallow chapstick,EXACT,554,1108.91,3242.63,40.1%,nonbrand ~26%,34.2%,,\"+10% (under BE, not full +15)\",,2026-07-06..09-04 ~60d ST,Core Exact under BE. Modest raise; rank gate may cap.\n49,GROW,bid_up,SP - 1KW - Exact(TOS) - lip balm -B0CLHVCPL5 - tallow lip balm organic,Exact,tallow lip balm organic,EXACT,481,1163.17,3636.7,48.4%,nonbrand ~26%,32.0%,,+15%,,2026-07-06..09-04 ~60d ST,30.7% L30 campaign ACOS. Scale + budget.\n50,GROW,bid_up,SP - 1KW - Exact - Lip Balm - B0CLHTKY3V - organic chapstick,B0CLHTKY3V,organic chapstick,EXACT,139,304.79,912.35,46.8%,nonbrand ~26%,33.4%,,+15%,,2026-07-06..09-04 ~60d ST,Exact already owns this \u2014 raise here; harvest row above cleans Broad.\n51,GROW,bid_up,SP - 1Branded KW(TOS) - Exact - Lip Balm - Mixed - -28ord,B0CLHVCPL5,tallowbourne lip balm,EXACT,97,171.32,733.48,51.5%,branded ~41%,23.4%,,+8% max (brand gate),,2026-07-06..09-04 ~60d ST,Brand defense/growth. Brief brand spend ~2% \u2014 raise gently.\n52,GROW,raise_tos,SP - KW (TOS) - Exact - Tallow Lip Balm KW,-,-,-,,1052.45,3345.54,51.4%,nonbrand ~26%,31.5%,,,Top of Search +10 to +20 pts (after DP cut on same campaign),2026-08-06..09-04 ~30d,TOS 31.5% ACOS / 51% CVR. Raise TOS ONLY after you cut this campaign\u2019s Detail Page (60% DP ACOS). Do not raise Hero Exact chapstick TOS.\n53,GROW,raise_tos,GG - B0CLHYY3BB - Deodorant - Asin Defense,-,-,-,,289.07,1030.38,37.3%,nonbrand ~26%,28.1%,,,Top of Search +15 to +25 pts,2026-08-06..09-04 ~30d,TOS 28% ACOS. Defense + growth. Pair with budget_up.\n54,GROW,raise_tos,SP - 1KW - Exact(TOS) - lip balm -B0CLHVCPL5 - tallow lip balm organic,-,-,-,,175.5,558.9,56.3%,nonbrand ~26%,31.4%,,,Top of Search +15 pts,2026-08-06..09-04 ~30d,TOS healthy; DP already fine. Scale impression share.\n55,GROW,raise_tos,SP - KW(4kSV/TOS) - Exact - Lip Balm - 3 Pack - B0CLHTKY3V - -tallow lip balm,-,-,-,,169.31,544.91,52.8%,nonbrand ~26%,31.1%,,,Top of Search +10 to +15 pts,2026-08-06..09-04 ~30d,TOS 31% ACOS twin Exact. Grow.\n56,GROW,budget_up,GG - B0CLHYY3BB - Deodorant - Asin Defense,-,-,-,,326.47,1112.33,34.7%,nonbrand ~26%,29.4%,budget ~$28/day,+$10\u201315/day (~$40\u201345),,2026-08-06..09-04 ~30d,Best L7 efficient campaign (24.7% ACOS). Budget is tiny vs performance \u2014 raise so it can spend.\n57,GROW,budget_up,SP - 1KW - Exact(TOS) - lip balm -B0CLHVCPL5 - tallow lip balm organic,-,-,-,,197.4,642.84,53.2%,nonbrand ~26%,30.7%,budget ~$18/day,+$10\u201315/day (~$30\u201335),,2026-08-06..09-04 ~30d,Under BE Exact with tiny budget \u2014 growth bottleneck.\n58,GROW,budget_up,SP - Exact - Lip Balm - B0CLHTKY3V - chap stick,-,-,-,,109.38,391.72,43.8%,nonbrand ~26%,27.9%,budget ~$38/day,+$10/day (~$48),,2026-08-06..09-04 ~30d,27.9% ACOS Exact. Give it room after bid_up.\n59,GROW,budget_up,GG - Lip Balm - Exact - SQR - Long/Low,-,-,-,,106.87,332.77,33.3%,nonbrand ~26%,32.1%,budget ~$13/day,+$10\u201315/day (~$25\u201330),,2026-08-06..09-04 ~30d,Peppermint Exact winner starved at $13.\n60,GROW,budget_up,SP - KW(4kSV/TOS) - Exact - Lip Balm - 3 Pack - B0CLHTKY3V - -tallow lip balm,-,-,-,,173.35,544.91,50.0%,nonbrand ~26%,31.8%,budget ~$68/day,+$15\u201320/day (~$85\u201390),,2026-08-06..09-04 ~30d,Under BE Exact twin. Modest budget raise.\n61,GROW,budget_up,SP - KW (TOS) - Exact - Tallow Lip Balm KW,-,-,-,,1475.75,4360.12,43.7%,nonbrand ~26%,33.8%,budget ~$153/day,+$20\u201330/day ONLY after DP cut + if daily ACOS stays \u226438%,,2026-08-06..09-04 ~30d,Largest profitable Exact engine L30. L7 days mixed \u2014 raise budget only after DP cut and a clean 2\u20133 day ACOS read. Do NOT raise Hero Exact chapstick budget (L7 53% ACOS).\n62,GROW,budget_up,SBPC  - KW - Exact(TOS) - Lip Balm - Mixed -,-,-,-,,396.89,1359.03,44.3%,nonbrand ~26%,29.2%,check live SB budget,+20% if not already maxed,,2026-08-06..09-04 ~30d,SB Exact 29% ACOS L30 \u2014 grow SB where efficient (no ST table; campaign-grain only).\n63,R2,bid_down,SP - Hero KW(256KsV/TOS) -  Exact - Lip Balm - 3 Pack - B0CLHTKY3V/B0CLHV3V5C - -chapstick,Exact / 3pk,chapstick,EXACT,631,1679.32,3725.35,40.9%,nonbrand ~26%,45.1%,,live CPC \u00d7 0.38 / 0.451 (~\u221216%),,2026-08-29..09-04 L7 ST (5/7 days \u2014 rank only),Dana L7 ST head: chapstick ~45% ACOS (just over BE). Surgery not pause. Bid down on Hero Exact owner; Neg Exact chapstick out of Broad/Auto (already in GROW). ST $ inflated \u2014 confirm live CPC in CM.\n64,HOLD,hold_bid,SP - KW (TOS) - Exact - Tallow Lip Balm KW,Exact,tallow lip balm,EXACT,618,1478.06,3273.87,37.1%,nonbrand ~26%,45.2%,,DO NOT CHANGE \u2014 rank defense,,2026-08-29..09-04 L7 ST (5/7 days \u2014 rank only),Dave 2026-09-05 KEEP tallow lip balm rank defense; skip bid_down; still do DP cut + raise_tos + budget_up on campaign family; do not pause.\n65,R2,bid_down,SP KW - Exact(PM) - Lip Balm - DPB0CLHTKY3V/B0CLHVLG2F -,Exact NonBranded,beef tallow lip balm,EXACT,272,655.68,1030.27,26.1%,nonbrand ~26%,63.6%,,live CPC \u00d7 0.38 / 0.636,,2026-08-29..09-04 L7 ST (5/7 days \u2014 rank only),L7 ST 63.6% ACOS across campaigns. Bid down Exact(PM) where spend concentrates. Still HARVEST Exact from Auto Loose (24% ACOS there) \u2014 different lever.\n66,R2,bid_down,GG - B0CLHYY3BB - Deodorant - Asin Defense,Asin Defense,tallow deodorant,TARGETING_EXPRESSION,77,261.02,272.83,15.6%,nonbrand ~26%,95.7%,,live CPC \u00d7 0.38 / 0.957,,2026-08-29..09-04 L7 ST (5/7 days \u2014 rank only),L7 ST 95.7% ACOS. Bid down defense targeting for this query; do not kill brand defense campaign. Harvest beef tallow deodorant to Exact stays.\n";

const LOOKUP_SKIP_TERMS = new Set(["", "-", "(campaign-level)", "loose-match"]);

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.length > 0)) rows.push(row);
  }
  return rows;
}

function parsePct(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s.replace(/%$/, ""));
  return Number.isFinite(n) ? n : null;
}

function parseNum(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseLane(raw: string): number | null {
  const m = raw.match(/([\d.]+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function blankToNull(raw: string): string | null {
  const s = raw.trim();
  return s ? s : null;
}

function isWeeklyAction(value: string): value is WeeklyAction {
  return (WEEKLY_ACTIONS as readonly string[]).includes(value);
}

export interface RecoverySpec {
  csv_id: number;
  rank: string;
  action: WeeklyAction;
  campaign: string;
  ad_group: string;
  term: string;
  match_type: string;
  clicks: number | null;
  spend: number;
  sales: number;
  term_cvr: number | null;
  account_cvr_lane: number | null;
  acos: number | null;
  current_bid: string | null;
  new_bid: string | null;
  placement: string | null;
  window: string;
  why: string;
}

export function parseRecoverySpecs(csv: string = RECOVERY_0905_CSV): RecoverySpec[] {
  const table = parseCsv(csv);
  if (table.length < 2) throw new Error("Recovery CSV missing header or rows");
  const header = table[0];
  if (header[0] !== "id" || header[header.length - 1] !== "why") {
    throw new Error("Recovery CSV header mismatch");
  }
  const specs = table.slice(1).map((cols, idx) => {
    if (cols.length !== 18) {
      throw new Error(`Recovery CSV row ${idx + 1} has ${cols.length} columns`);
    }
    const action = cols[2];
    if (!isWeeklyAction(action)) {
      throw new Error(`Recovery CSV unknown action: ${action}`);
    }
    const spend = parseNum(cols[8]);
    const sales = parseNum(cols[9]);
    if (spend == null || sales == null) {
      throw new Error(`Recovery CSV row ${cols[0]} missing spend/sales`);
    }
    return {
      csv_id: Number(cols[0]),
      rank: cols[1],
      action,
      campaign: cols[3],
      ad_group: cols[4],
      term: cols[5],
      match_type: cols[6],
      clicks: parseNum(cols[7]),
      spend,
      sales,
      term_cvr: parsePct(cols[10]),
      account_cvr_lane: parseLane(cols[11]),
      acos: parsePct(cols[12]),
      current_bid: blankToNull(cols[13]),
      new_bid: blankToNull(cols[14]),
      placement: blankToNull(cols[15]),
      window: cols[16],
      why: cols[17],
    };
  });
  if (specs.length !== BLAKE_RECOVERY_0905_ROW_COUNT) {
    throw new Error(`Recovery CSV must have ${BLAKE_RECOVERY_0905_ROW_COUNT} data rows, got ${specs.length}`);
  }
  return specs;
}

function lookupTerm(term: string): string | undefined {
  const key = term.trim().toLowerCase();
  if (LOOKUP_SKIP_TERMS.has(key)) return undefined;
  return term;
}

function searchWindow(): WeeklyWindow {
  return {
    start: BLAKE_RECOVERY_0905_START,
    end: BLAKE_RECOVERY_0905_END,
    days: BLAKE_RECOVERY_0905_DAYS,
    days_with_rows: BLAKE_RECOVERY_0905_DAYS,
    label: BLAKE_RECOVERY_0905_WINDOW_LABEL,
  };
}

function placementWindow(): WeeklyWindow {
  return {
    start: "2026-08-06",
    end: BLAKE_RECOVERY_0905_END,
    days: 30,
    days_with_rows: 30,
    label: BLAKE_RECOVERY_0905_PLACEMENT_LABEL,
  };
}

export function blakeRecovery0905Window(): WeeklyWindow {
  return searchWindow();
}

export const WEEKLY_HOLD_RECOVERY_0905 = [
  ...WEEKLY_HOLD,
  "SCALE bid_up only after P0–P1 waste cuts. GROW under-BE Exact may scale the same day.",
  "Brand defense: hold or +8% max. Do not cut. Brand is underspend (~2% of ST).",
  "Do not raise Hero Exact chapstick TOS or budget (L7 53% ACOS).",
  "Id 64 tallow lip balm is hold_bid — DO NOT CHANGE (rank defense). Still do DP cut + raise_tos + budget_up on that campaign family. No blanket kill on chapstick or tallow lip balm.",
  "Ids 63/65/66 are L7 head-term surgery — bid_down, never pause.",
] as const;

export function buildBlakeRecovery0905List(input: {
  lookup?: BlakeLookup;
  decisions?: WeeklyLockDecision[];
  account_cvr?: number;
  now?: Date;
} = {}): WeeklyPayload {
  const lookup: BlakeLookup = {
    campaigns: input.lookup?.campaigns ?? [],
    terms: input.lookup?.terms ?? [],
    placements: input.lookup?.placements ?? [],
  };
  const specs = parseRecoverySpecs();
  const raw: WeeklyRow[] = specs.map((spec) => {
    const resolved = resolveNamedCampaign(
      spec.campaign,
      lookup,
      lookupTerm(spec.term),
    );
    return {
      id: `recovery-0905-${spec.csv_id}`,
      rank: spec.rank,
      action: spec.action,
      campaign: spec.campaign,
      campaign_id: resolved.campaign_id,
      ad_group: spec.ad_group,
      term: spec.term,
      match_type: spec.match_type,
      clicks: spec.clicks,
      spend: spec.spend,
      sales: spec.sales,
      acos: spec.acos,
      term_cvr: spec.term_cvr,
      account_cvr_lane: spec.account_cvr_lane,
      current_bid: spec.current_bid,
      new_bid: spec.new_bid,
      placement: spec.placement,
      window: spec.window,
      why: spec.why,
      status: "open",
      decision_id: null,
    };
  });

  const locked = applyWeeklyLocks(raw, input.decisions ?? [], input.now ?? new Date());
  const open_count = locked.filter((r) => r.status === "open").length;
  const done_count = locked.filter((r) => r.status === "done").length;
  const skipped_count = locked.filter((r) => r.status === "skipped").length;

  return {
    execute_ready: true,
    execute_list: "blake_recovery_0905",
    window_chip: BLAKE_RECOVERY_0905_WINDOW_CHIP,
    break_even_pct: BLAKE_RECOVERY_0905_BE,
    window: { search: searchWindow(), placement: placementWindow() },
    account_cvr: input.account_cvr ?? BLAKE_RECOVERY_0905_LANE.nonbrand,
    account_cvr_source: "ads_campaigns_daily",
    account_cvr_branded: BLAKE_RECOVERY_0905_LANE.branded,
    account_cvr_nonbranded: BLAKE_RECOVERY_0905_LANE.nonbrand,
    lane_cvr_source: "ads_search_terms_daily + brand_terms.json",
    click_floor: BLAKE_RECOVERY_0905_CLICK_FLOOR,
    open_count,
    done_count,
    skipped_count,
    search_term_coverage: "SP-only",
    notes: [
      "Recovery Sep 5 — Blake-ranked 66-row execute list. ST ~60d through 2026-09-04 (2026-07-06..09-04). L7 overlay 2026-08-29..09-04. Placement ~30d 2026-08-06..09-04. BE 37.9%. Click floor 6.",
      "Order: cuts first (R1 → R2 → P1 → HOLD), then SCALE/DEFEND, then GROW (harvest_exact, bid_up, raise_tos, budget_up), then L7 head-term R2 surgery (ids 63–66).",
      "Recommend-only. Mark Done or Skipped after Seller Central. Done/Skipped persist on ads_action_decisions (7-day lock). Still-$0 bleeders may reappear. Nothing writes to Amazon.",
      "Bleeders 1.0 10 stays secondary triage. This week is Recovery only. Do not auto-buildBleeders. new_bid down = live CPC × 0.38 / ACOS (BE 37.9%).",
    ],
    cadence: [...WEEKLY_CADENCE],
    hold: [...WEEKLY_HOLD_RECOVERY_0905],
    grok_prompt: WEEKLY_GROK_PROMPT_RECOVERY_0905,
    new_bid: {
      down: "live CPC × 0.38 / ACOS (BE 37.9%)",
      up: "+15% after P0–P1 unless the row says otherwise",
      current_bid: null,
    },
    lock: {
      days: WEEKLY_LOCK_DAYS,
      exception: "still-$0 bleeders may reappear",
    },
    rows: locked,
  };
}
