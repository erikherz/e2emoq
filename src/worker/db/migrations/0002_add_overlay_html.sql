-- Add overlay_html column to streams table for broadcaster HTML overlays
ALTER TABLE streams ADD COLUMN overlay_html TEXT DEFAULT '';
