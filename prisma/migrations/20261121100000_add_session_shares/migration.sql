-- CreateTable
CREATE TABLE "session_shares" (
    "id" TEXT NOT NULL,
    "orderSessionId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "showName" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "session_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "session_shares_orderSessionId_key" ON "session_shares"("orderSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "session_shares_token_key" ON "session_shares"("token");

-- AddForeignKey
ALTER TABLE "session_shares" ADD CONSTRAINT "session_shares_orderSessionId_fkey" FOREIGN KEY ("orderSessionId") REFERENCES "order_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
