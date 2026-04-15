// API endpoint: /api/items.js
// Returns all items from BR Items.xlsx as JSON for admin panel

const xlsx = require('xlsx');
const path = require('path');

module.exports = async (req, res) => {
  try {
    const filePath = path.join(process.cwd(), 'BR Items.xlsx');
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const items = xlsx.utils.sheet_to_json(sheet);
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
