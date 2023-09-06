const express = require("express");
const morgan = require("morgan");
const Redis = require("ioredis");
const redisClient = new Redis();
const config = require("./config");
const mariadb = require("mariadb");
const pool = mariadb.createPool({
    host: config.db.host,
    user: config.db.user,
    password: config.db.pw,
    database: config.db.db,
    connectionLimit: 5,
});

const MODES = {
    osu: 0,
    taiko: 1,
    fruits: 2,
    mania: 3,
};

const api = express();
const port = config.api.port;

function parseMode(mode, m) {
    let resolveMode = "";

    if (m == undefined) {
        if (["osu", "mania", "taiko", "fruits"].includes(mode) == -1 || mode == undefined) {
            resolveMode = "osu";
        } else {
            resolveMode = mode;
        }
    } else {
        switch (m) {
            case "0":
                resolveMode = "osu";
                break;
            case "1":
                resolveMode = "taiko";
                break;
            case "2":
                resolveMode = "fruits";
                break;
            case "3":
                resolveMode = "mania";
                break;
            default:
                resolveMode = "osu";
                break;
        }
    }
    return resolveMode;
}

function isEmpty(object) {
    for (const property in object) {
        return false;
    }
    return true;
}

async function getPeakRank(user_id, mode) {
    let conn;
    let rows;
    try {
        conn = await pool.getConnection();
        rows = await conn.query(
            "SELECT * FROM osu_score_rank_highest WHERE user_id = ? AND mode = ?",
            [user_id, MODES[mode]]
        );
    } finally {
        if (conn) conn.end();
    }
    let rank_highest = { rank: rows[0]?.rank ?? 0, updated_at: rows[0]?.updated_at ?? null };
    return rank_highest;
}

async function main() {
    api.listen(port, () => {
        console.log(`api listening on port ${port}`);
    });

    api.use(morgan("dev"));
    api.use(require("express-status-monitor")());

    api.get("/rank/*", async (req, res) => {
        let mode = parseMode(req.query.mode, req.query.m);

        let rank = req.path.split("/").pop();
        let rank_user = await redisClient.zrevrange(
            `score_${mode}`,
            rank - 1,
            rank - 1,
            "WITHSCORES"
        );
        let data = {};

        for (let i = 0; i < rank_user.length; i += 2) {
            data["rank"] = parseInt(rank);
            data["user_id"] = parseInt(rank_user[i]);
            data["username"] = await redisClient.get(`user_${rank_user[i]}`);
            data["score"] = parseInt(rank_user[i + 1]);
            data["rank_highest"] = await getPeakRank(rank_user[i], mode);
        }

        if (isEmpty(data)) {
            res.status(200);
            res.json([{ rank: 0, user_id: 0, username: 0, score: 0 }]);
        } else {
            res.status(200);
            res.json([data]);
        }
    });

    api.get("/u/:users", async (req, res) => {
        let mode = parseMode(req.query.mode, req.query.m);
        let users = req.params.users.split(",");

        if (["username", "user_id"].includes(req.query.s) == -1 || req.query.s == undefined) {
            req.query.s = "user_id";
        }

        let results = [];

        if (users.length > 100) {
            res.status(400);
            res.json({ error: "Too many users. Max limit is 100." });
            return;
        }

        for (const user of users) {
            let user_id;
            if (req.query.s == "username") {
                user_id = await redisClient.get(`user_${user}`);
            } else {
                user_id = user;
            }

            let rank_highest = await getPeakRank(user_id, mode);

            let [score, rank, usernameValue] = await Promise.all([
                redisClient.zscore(`score_${mode}`, user_id),
                redisClient.zrevrank(`score_${mode}`, user_id),
                redisClient.get(`user_${user_id}`),
            ]);
            let data = {
                rank: rank == null ? 0 : rank + 1,
                user_id: parseInt(user_id) || 0,
                username: usernameValue || 0,
                score: parseInt(score) || 0,
                rank_highest: rank_highest ?? null,
            };
            results.push(data);
        }

        res.status(200);
        res.json(results);
    });

    api.get("/rankings", async (req, res) => {
        let mode = parseMode(req.query.mode, req.query.m);

        if (
            req.query.page > 200 ||
            req.query.page < 1 ||
            req.query.page == undefined ||
            isNaN(req.query.page)
        ) {
            req.query.page = 1;
        }

        let start_rank = (req.query.page - 1) * 50;
        let rankings = await redisClient.zrevrange(
            `score_${mode}`,
            start_rank,
            start_rank + 49,
            "WITHSCORES"
        );

        let lb = {};
        let r = 0;

        for (let i = 0; i < rankings.length; i += 2) {
            lb[r] = {};
            lb[r]["rank"] = (await redisClient.zrevrank(`score_${mode}`, rankings[i])) + 1;
            lb[r]["user_id"] = parseInt(rankings[i]);
            lb[r]["username"] = await redisClient.get(`user_${rankings[i]}`);
            lb[r]["score"] = parseInt(rankings[i + 1]);
            lb[r]["rank_highest"] = await getPeakRank(rankings[i], mode);
            r++;
        }

        res.status(200);
        res.json(lb);
    });
}

main();
