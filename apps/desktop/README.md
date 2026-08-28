# PrintShop Hub

A complete print shop management system that runs on your local network. Customers can upload documents from their phones or laptops, and the shop owner manages everything from a single dashboard.

---

## What It Does

PrintShop Hub replaces the traditional "send me the file on WhatsApp" workflow with a streamlined, organized system.

**For customers:**
- Open the shop's webpage on your phone (via QR code or link)
- Upload your documents — PDF, images, Word files, Excel sheets
- Choose color or black & white, number of copies, paper type
- See the price instantly before submitting
- Track your job status (pending / printed)

**For the shop owner:**
- See all incoming print jobs in one place
- Update job status as you print them
- Download files, preview documents, print directly from the browser
- Set your own pricing per paper type and color mode
- Create discount rules (e.g., "10% off for orders over 50 pages")
- Upload your shop logo, change the shop name, customize paper types
- Receive print jobs directly from customer emails (Gmail integration)

---

## How It Works

The app runs on a computer inside the shop — no internet hosting required. Any device on the same Wi-Fi network can access it through a web browser.

1. **Customers scan a QR code** (displayed on the upload page) or type the local address
2. **They fill in their name and phone**, upload files, pick print preferences
3. **The job appears instantly** on the admin dashboard
4. **The shop owner prints** the file and marks it as done
5. **The customer sees** their job status change to "Printed"

---

## Key Benefits

- **No more WhatsApp chaos** — files come in organized, not lost in chat history
- **Customers serve themselves** — they upload their own files, pick preferences, see prices
- **Works offline** — no internet needed, everything runs on your local network
- **Bilingual** — full Arabic and English support with right-to-left layout
- **Free & open source** — no subscriptions, no monthly fees
- **Email to print** — customers can email documents and they appear as print jobs automatically

---

## Quick Setup

```bash
npm install
npm run dev
```

Open `http://localhost:5000` in your browser. The admin area is at `http://localhost:5000#admin` with default password `admin123`.

For production use on a local network, run:

```bash
npm run build
npm start
```

The app will be available on port 3000. Use the QR code on the upload page to let customers connect from their phones.

---

## Features at a Glance

| Feature | What it does |
|---------|-------------|
| File upload | Drag-and-drop files, supports PDF, images, Word, Excel |
| Auto page count | Counts pages in PDFs automatically for accurate pricing |
| Price calculator | Shows customers the price before they submit |
| Discount rules | Set percentage or fixed discounts by page count or total |
| Print preferences | Per-job settings for color/B&W, copies, paper type |
| Admin dashboard | Manage jobs, settings, pricing, paper types, discounts |
| Gmail integration | Auto-import emailed attachments as print jobs |
| Image editor | Crop and adjust images before printing |
| Card printing tool | Design and print ID cards with front/back layout |
| QR code access | Scan to open the upload page on any device |
| Arabic/English | Full bilingual interface with RTL layout |
| Keyboard shortcuts | Ctrl+K for admin, Ctrl+U for upload, Escape to go back |

---

## Who It's For

- Small print shops and copy centers
- University printing services
- Library printing stations
- Any business that accepts print jobs from walk-in customers
