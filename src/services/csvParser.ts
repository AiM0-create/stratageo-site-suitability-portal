/**
 * CSV Parser — Validates and parses user-uploaded CSV files with lat/lon data.
 *
 * Supports flexible column headers, validates coordinate ranges,
 * and returns structured points with metadata.
 */

import type { UserPoint } from '../types';

export interface ParsedCSVResult {
  points: UserPoint[];
  errors: string[];
  warnings: string[];
}

const MAX_POINTS = 500;

// Flexible header matching
const LAT_HEADERS = ['latitude', 'lat', 'y', 'lat_y'];
const LNG_HEADERS = ['longitude', 'lng', 'lon', 'long', 'x', 'lng_x'];
const NAME_HEADERS = ['name', 'label', 'title', 'location', 'place', 'site'];
const CATEGORY_HEADERS = ['category', 'type', 'kind', 'class', 'group'];

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function findColumnIndex(headers: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const idx = headers.findIndex(h => normalizeHeader(h) === candidate);
    if (idx !== -1) return idx;
  }
  return -1;
}

function isValidLat(v: number): boolean {
  return !isNaN(v) && v >= -90 && v <= 90;
}

function isValidLng(v: number): boolean {
  return !isNaN(v) && v >= -180 && v <= 180;
}

function parseLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

export function parseCSV(text: string): ParsedCSVResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const points: UserPoint[] = [];

  if (!text || !text.trim()) {
    errors.push('CSV file is empty.');
    return { points, errors, warnings };
  }

  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);

  if (lines.length < 2) {
    errors.push('CSV must have a header row and at least one data row.');
    return { points, errors, warnings };
  }

  // Parse header
  const headers = parseLine(lines[0]);
  const latIdx = findColumnIndex(headers, LAT_HEADERS);
  const lngIdx = findColumnIndex(headers, LNG_HEADERS);
  const nameIdx = findColumnIndex(headers, NAME_HEADERS);
  const catIdx = findColumnIndex(headers, CATEGORY_HEADERS);

  if (latIdx === -1 || lngIdx === -1) {
    const found = headers.map(h => `"${h}"`).join(', ');
    errors.push(
      `Could not find latitude/longitude columns. Found columns: ${found}. ` +
      `Expected one of: ${LAT_HEADERS.join(', ')} for latitude and ${LNG_HEADERS.join(', ')} for longitude.`
    );
    return { points, errors, warnings };
  }

  // Parse data rows
  let skippedCount = 0;

  for (let i = 1; i < lines.length; i++) {
    if (points.length >= MAX_POINTS) {
      warnings.push(`CSV truncated at ${MAX_POINTS} points. ${lines.length - 1 - MAX_POINTS} additional rows ignored.`);
      break;
    }

    const cols = parseLine(lines[i]);

    const latStr = cols[latIdx];
    const lngStr = cols[lngIdx];

    if (!latStr || !lngStr) {
      skippedCount++;
      continue;
    }

    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);

    if (!isValidLat(lat) || !isValidLng(lng)) {
      skippedCount++;
      continue;
    }

    const point: UserPoint = { lat, lng };

    if (nameIdx !== -1 && cols[nameIdx]) {
      point.name = cols[nameIdx].replace(/^["']|["']$/g, '');
    }
    if (catIdx !== -1 && cols[catIdx]) {
      point.category = cols[catIdx].replace(/^["']|["']$/g, '');
    }

    points.push(point);
  }

  if (skippedCount > 0) {
    warnings.push(`${skippedCount} row(s) skipped due to missing or invalid coordinates.`);
  }

  if (points.length === 0) {
    errors.push('No valid coordinate rows found in CSV. Check that latitude and longitude values are numeric and within valid ranges.');
  }

  return { points, errors, warnings };
}
