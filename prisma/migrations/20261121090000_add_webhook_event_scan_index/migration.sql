-- Automatic data deletion looks for payment events by source, kind and time before it touches an order.
-- CreateIndex
CREATE INDEX "webhook_events_source_eventType_processedAt_idx" ON "webhook_events"("source", "eventType", "processedAt");
