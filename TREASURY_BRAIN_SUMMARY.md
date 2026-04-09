# Treasury Brain — Project Summary & Specification

> Source document: `Treasury Brain.docx`
> Captured: 9 April 2026

---

## What It Is

A treasury management system currently operated through **Google Sheets**, run across three companies under the SA Bullion group. Each company runs identical sheets independently, reconciled on a **daily, monthly, and yearly** basis.

| Entity | Full Name | Currency | Focus |
|---|---|---|---|
| **SABIS** | SA Bullion Investor Services | ZAR | Local retail/wholesale |
| **SABI** | SA Bullion International | USD | Offshore |
| **SABGB** | SA Bullion Gold Buyers | ZAR | Secondary/scrap to melt |

---

## Core Objectives

- Calculate Gross Profit (GP)
- Manage price risk and market exposure
- Manage physical inventory
- Control hedging operations and costs
- Track cash flow *(feature wanted)*

---

## SABIS Tracking (Most Detailed)

SABIS tracks:
- Physical gold and silver **sales and buybacks/purchases** (daily → monthly → yearly)
- **Hedging longs** (buy positions on gold/silver futures)
- **Hedging shorts** (sell positions on gold/silver futures)
- **Total inventory** relative to all buybacks and sales for the day
- **Reconciliation** with accounting system (Sage) on inventory levels on hand
- **Gold proof coins** — separate metals sheet, perpetual accounting system
- **Silver proof coins** — tracked separately from silver bullion coins

---

## KEY ASPECT — Provision / No Provision System

> Used in **SABIS only** (not SABI or SABGB)

The system operates in one of two modes based on ecosystem inventory levels:

### PROVISION MODE (inventory is negative = oversold)

Inventory being negative means the company has theoretically oversold its stock, is sitting on equivalent cash, and will need to buy stock back at some point.

**All buys and sells are provisioned at the standard margin for that metal:**

| Metal | Provision % |
|---|---|
| Gold | 4.5% above spot |
| Silver | 8% above spot |

**For Buybacks (purchases from clients):**
- Provision % = baseline cost margin
- Profit = Provision % minus the buyback margin paid
- Example: Provision 4.5%, buy at spot +0% → profit = **4.5%**

**For Sales (to clients):**
- Provision % = baseline cost margin
- Profit = Sale margin minus provision %
- Example: Provision 4.5%, sell at spot +6.5% → profit = **2%**

---

### NO PROVISION MODE (inventory is positive = stock on hand)

Inventory being positive means the company has used cash to acquire physical stock and has it available to sell — no need to provision for future buybacks.

**Provision drops to 0% on all buys and sells.**

**For Buybacks:**
- Baseline cost = 0%
- Buy below spot → profit | Buy above spot → loss
- Example: Buy at spot -1% → profit = **+1%** | Buy at spot +1% → loss = **-1%**

**For Sales:**
- Baseline cost = 0%
- Sell above spot → profit | Sell below spot → loss
- Example: Sell at spot +1% → profit = **+1%** | Sell at spot -1% → loss = **-1%**

---

## Dealing & GP Capture

**Key:** M = Manually captured | A = Automated calculation

Two tables per metal (gold / silver):
1. **Physical Purchases** (buybacks from clients)
2. **Physical Sales** (to clients)

Both tables are structurally identical — inputs and calculations are the same. The difference is in outcome: purchases calculate profit from metals acquired under provision; sales calculate profit from metals sold above provision.

All raw data comes from **dealers' dealing sheets**.

### Deal Capture Fields

| Field | Type | Notes |
|---|---|---|
| Deal source | M | Dealer or SA Bullion app |
| Silo | M | Retail, wholesale, or custody |
| Product code | M | Dropdown of all gold/silver items |
| Product name | A | XLOOKUP referencing product code |
| Equivalent oz | A | XLOOKUP referencing product code |
| Units purchased/sold | M | |
| Client name & surname | M | |
| Oz | A | Equivalent oz × units |
| Running total oz | A | |
| Spot price | M | |
| Deal value | A | Oz × spot price |
| Running total deal value | A | |
| Running total VWAP | A | Running total deal value ÷ running total oz |
| Margin paid over/under spot | M | |
| Margin VWAP for the day | A | (Margin × oz) ÷ total oz for the day |
| Provision | M | If in place |
| Profit margin for the day | A | Provision minus margin VWAP |
| GP contribution | A | Profit margin × net deal value for the day |

---

## Current State

- Running entirely on **Google Sheets**
- Sheets are **manually maintained** per company
- Combined and reconciled manually across entities

## Project Goal

Build a proper **Treasury Management System** to replace/augment the Google Sheets setup, incorporating:
- Automated deal capture and GP calculation
- Provision/No Provision logic engine
- Inventory tracking across SABIS, SABI, SABGB
- Hedging position tracking
- Cash flow tracking
- Daily/monthly/yearly reconciliation
- Integration with Sage accounting system

---

*Summary captured by Claude Code — 9 April 2026*
