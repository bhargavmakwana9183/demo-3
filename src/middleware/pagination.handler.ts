export const paginationMiddleware = (req, res, next) => {
    try {
        // Support query (GET list APIs) and body (legacy POST wrappers)
        const rawIndex =
            req.query?.pageIndex ??
            req.query?.page ??
            req.body?.data?.pageIndex ??
            req.body?.pageIndex;
        const rawSize =
            req.query?.pageSize ??
            req.query?.limit ??
            req.body?.data?.pageSize ??
            req.body?.pageSize;

        const pageIndex = parseInt(String(rawIndex), 10);
        const pageSize = parseInt(String(rawSize), 10);

        if (
            !Number.isFinite(pageIndex) ||
            !Number.isFinite(pageSize) ||
            pageIndex <= 0 ||
            pageSize <= 0
        ) {
            // Sensible defaults for list endpoints so we never dump entire tables
            req.paginations = { limit: 20, offset: 0 };
            return next();
        }

        const safeSize = Math.min(pageSize, 200);
        req.paginations = {
            limit: safeSize,
            offset: (pageIndex - 1) * safeSize,
        };
        next();
    } catch (error) {
        next(error);
    }
};
