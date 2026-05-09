-- Snake Clash — Playdate edition
-- Compile: pdc source/ SnakeClash.pdx
-- Load:    copy SnakeClash.pdx to /Games on your Playdate SD card

import "CoreLibs/graphics"
import "CoreLibs/timer"

local gfx <const> = playdate.graphics

-- ── Constants ──────────────────────────────────────────────────────
local W, H       <const> = 400, 240
local GRID       <const> = 8
local COLS       <const> = W // GRID   -- 50
local ROWS       <const> = H // GRID   -- 30
local GAME_DURATION <const> = 180      -- seconds before boss
local BOSS_WARN  <const> = 10          -- seconds of warning

-- ── Crank boost ────────────────────────────────────────────────────
-- getCrankChange() returns degrees rotated since last frame.
-- We accumulate absolute rotation into a 0-100 meter.
-- >= 40 on the meter activates boost (snake moves ~2x faster).
local CRANK_SCALE      <const> = 0.5   -- degrees → meter units
local CRANK_DECAY_RATE <const> = 18    -- meter units drained per second at rest
local CRANK_BOOST_SPD  <const> = 0.45  -- speed multiplier while boosting
local CRANK_BOOST_MIN  <const> = 40    -- meter level required to boost

-- ── Characters ─────────────────────────────────────────────────────
local CHARACTERS = {
    {
        name          = "VIPER",
        desc          = "Speed Burst",
        tip           = "Ⓐ: Dash 3 tiles",
        headChar      = "V",
        baseSpeed     = 200,   -- ms per move (higher = slower)
        ability       = "dash",
        abilityCooldown = 5000,
    },
    {
        name          = "CHOMPER",
        desc          = "Wide Bite",
        tip           = "Ⓐ: Eat nearby tiles",
        headChar      = "C",
        baseSpeed     = 240,
        ability       = "widebite",
        abilityCooldown = 6000,
    },
    {
        name          = "SHIELD",
        desc          = "Barrier",
        tip           = "Ⓐ: Invincible 2s",
        headChar      = "S",
        baseSpeed     = 220,
        ability       = "shield",
        abilityCooldown = 8000,
    },
}

local DIRS        <const> = { "up", "down", "left", "right" }
local OPPOSITE    <const> = { up="down", down="up", left="right", right="left" }
local ENEMY_CFGS  <const> = {
    { length=3,  speed=320, points=30  },
    { length=5,  speed=290, points=60  },
    { length=8,  speed=260, points=100 },
    { length=12, speed=340, points=150 },
}

-- ── State ──────────────────────────────────────────────────────────
local state         = "title"
local player        = nil
local enemies       = {}
local boss          = nil
local score         = 0
local highScores    = {}
local timeLeft      = GAME_DURATION
local bossSpawned   = false
local bossWarning   = false
local selectedChar  = 1
local particles     = {}
local crankMeter    = 0
local crankBoosting = false
local lastTime      = 0
local gameOverPending  = false
local gameOverTimer    = 0
local enterNameMode    = false
local nameInput        = ""
local nameCursorPos    = 1
local NAME_CHARS <const> = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

-- ── Persistence ────────────────────────────────────────────────────
local function loadScores()
    local data = playdate.datastore.read()
    if data and data.scores then return data.scores end
    return {}
end

local function saveScores()
    playdate.datastore.write({ scores = highScores })
end

local function addScore(name, pts)
    table.insert(highScores, { name = name, score = pts })
    table.sort(highScores, function(a, b) return a.score > b.score end)
    if #highScores > 10 then table.remove(highScores, 11) end
    saveScores()
end

-- ── Utilities ──────────────────────────────────────────────────────
local function dirVec(d)
    if     d == "up"    then return  0, -1
    elseif d == "down"  then return  0,  1
    elseif d == "left"  then return -1,  0
    elseif d == "right" then return  1,  0
    end
    return 0, 0
end

local function centeredX(text)
    local tw, _ = gfx.getTextSize(text)
    return W // 2 - tw // 2
end

-- ── Particles ──────────────────────────────────────────────────────
local function spawnParticles(gx, gy, n)
    for _ = 1, n do
        table.insert(particles, {
            x      = gx * GRID + GRID / 2,
            y      = gy * GRID + GRID / 2,
            vx     = (math.random() - 0.5) * 60,
            vy     = (math.random() - 0.5) * 60,
            life   = 400,
            maxLife = 400,
        })
    end
end

local function updateParticles(delta)
    for i = #particles, 1, -1 do
        local p = particles[i]
        p.x    += p.vx * delta / 1000
        p.y    += p.vy * delta / 1000
        p.life -= delta
        if p.life <= 0 then table.remove(particles, i) end
    end
end

local function drawParticles()
    gfx.setColor(gfx.kColorWhite)
    for _, p in ipairs(particles) do
        gfx.fillRect(math.floor(p.x) - 1, math.floor(p.y) - 1, 2, 2)
    end
end

-- ── Snake ──────────────────────────────────────────────────────────
local function newSnake(x, y, dir, length, speed, isPlayer, charDef)
    local dx, dy = dirVec(dir)
    local segs = {}
    for i = 0, length - 1 do
        table.insert(segs, { x = x - i * dx, y = y - i * dy })
    end
    return {
        segments        = segs,
        dir             = dir,
        nextDir         = dir,
        speed           = speed,
        moveTimer       = 0,
        isPlayer        = isPlayer or false,
        charDef         = charDef,
        alive           = true,
        eatProgress     = 0,
        points          = length * 10,
        isBoss          = false,
        abilityTimer    = 0,
        abilityCooldown = charDef and charDef.abilityCooldown or 0,
        abilityActive   = false,
        abilityDuration = 0,
        shielded        = false,
        wideBite        = false,
        aiTimer         = 0,
    }
end

local function snakeHead(s) return s.segments[1] end

local function snakeTurnTo(s, d)
    if d ~= OPPOSITE[s.dir] then s.nextDir = d end
end

local function snakeStep(s)
    s.dir = s.nextDir
    local dx, dy = dirVec(s.dir)
    local h = snakeHead(s)
    local nx = (h.x + dx) % COLS
    local ny = (h.y + dy) % ROWS
    table.insert(s.segments, 1, { x = nx, y = ny })
    table.remove(s.segments)
end

local function useAbility(s)
    if not s.charDef or s.abilityTimer > 0 then return end
    s.abilityTimer = s.charDef.abilityCooldown
    local ab = s.charDef.ability
    if ab == "dash" then
        for _ = 1, 3 do snakeStep(s) end
    elseif ab == "widebite" then
        s.wideBite      = true
        s.abilityDuration = 3000
        s.abilityActive = true
    elseif ab == "shield" then
        s.shielded      = true
        s.abilityDuration = 2000
        s.abilityActive = true
    end
    spawnParticles(snakeHead(s).x, snakeHead(s).y, 6)
end

local function updateSnake(s, delta)
    if not s.alive then return end
    s.moveTimer += delta
    local spd = s.speed
    if s.isPlayer and crankBoosting then spd *= CRANK_BOOST_SPD end
    if s.charDef and s.charDef.ability == "dash" and s.abilityActive then spd *= 0.4 end
    if s.moveTimer >= spd then
        s.moveTimer -= spd
        snakeStep(s)
    end
    if s.abilityActive then
        s.abilityDuration -= delta
        if s.abilityDuration <= 0 then
            s.abilityActive = false
            s.shielded      = false
            s.wideBite      = false
        end
    end
    if s.abilityTimer > 0 then
        s.abilityTimer = math.max(0, s.abilityTimer - delta)
    end
end

local function drawSnake(s)
    if not s.alive then return end
    local now   = playdate.getCurrentTimeMilliseconds()
    local flash = s.shielded and (now // 100) % 2 == 0
    local h     = snakeHead(s)
    local hx, hy = h.x * GRID, h.y * GRID

    if s.isPlayer then
        -- Body: alternating filled / hollow segments
        for i = 2, #s.segments do
            local seg = s.segments[i]
            local sx, sy = seg.x * GRID, seg.y * GRID
            if i % 2 == 0 then
                gfx.setColor(gfx.kColorWhite)
                gfx.fillRect(sx + 1, sy + 1, GRID - 2, GRID - 2)
            else
                gfx.setColor(gfx.kColorWhite)
                gfx.drawRect(sx + 1, sy + 1, GRID - 2, GRID - 2)
            end
        end
        -- Glow ring around head
        if not flash then
            gfx.setColor(gfx.kColorWhite)
            gfx.drawRect(hx - 2, hy - 2, GRID + 4, GRID + 4)
        end
        -- Head fill
        gfx.setColor(gfx.kColorWhite)
        gfx.fillRect(hx - 1, hy - 1, GRID + 2, GRID + 2)
        -- Head letter (black on white)
        gfx.setImageDrawMode(gfx.kDrawModeFillBlack)
        gfx.drawText(s.charDef.headChar, hx, hy)
        gfx.setImageDrawMode(gfx.kDrawModeCopy)
        -- Direction arrow
        gfx.setColor(gfx.kColorWhite)
        local cx, cy = hx + GRID // 2, hy + GRID // 2
        if s.dir == "up" then
            gfx.fillTriangle(cx, hy - 5, cx - 3, hy - 1, cx + 3, hy - 1)
        elseif s.dir == "down" then
            gfx.fillTriangle(cx, hy + GRID + 5, cx - 3, hy + GRID + 1, cx + 3, hy + GRID + 1)
        elseif s.dir == "left" then
            gfx.fillTriangle(hx - 5, cy, hx - 1, cy - 3, hx - 1, cy + 3)
        elseif s.dir == "right" then
            gfx.fillTriangle(hx + GRID + 5, cy, hx + GRID + 1, cy - 3, hx + GRID + 1, cy + 3)
        end
    else
        -- Enemy body: hollow outlines only (clearly not the player)
        gfx.setColor(gfx.kColorWhite)
        for i = 2, #s.segments do
            local seg = s.segments[i]
            gfx.drawRect(seg.x * GRID + 2, seg.y * GRID + 2, GRID - 4, GRID - 4)
        end
        -- Enemy head: small filled square
        gfx.setColor(s.isBoss and gfx.kColorWhite or gfx.kColorWhite)
        gfx.fillRect(hx + 1, hy + 1, GRID - 2, GRID - 2)
        -- Eaten tail sections: draw an X through them
        if s.eatProgress > 0 then
            local startIdx = #s.segments - s.eatProgress + 1
            gfx.setColor(gfx.kColorBlack)
            for i = math.max(2, startIdx), #s.segments do
                local seg = s.segments[i]
                local sx, sy = seg.x * GRID + 2, seg.y * GRID + 2
                gfx.fillRect(sx, sy, GRID - 4, GRID - 4)
            end
        end
    end
end

-- ── Spawning ───────────────────────────────────────────────────────
local function isTooClose(x, y, dist)
    if player then
        local ph = snakeHead(player)
        if math.abs(ph.x - x) < dist and math.abs(ph.y - y) < dist then return true end
    end
    for _, e in ipairs(enemies) do
        local eh = snakeHead(e)
        if math.abs(eh.x - x) < dist and math.abs(eh.y - y) < dist then return true end
    end
    return false
end

local function spawnOneEnemy()
    local cfg = ENEMY_CFGS[math.random(#ENEMY_CFGS)]
    local dir = DIRS[math.random(#DIRS)]
    local x, y, attempts = 0, 0, 0
    repeat
        x = math.random(2, COLS - 3)
        y = math.random(2, ROWS - 3)
        attempts += 1
    until not isTooClose(x, y, 6) or attempts >= 20
    local e    = newSnake(x, y, dir, cfg.length, cfg.speed)
    e.points   = cfg.points
    table.insert(enemies, e)
end

local function spawnEnemies(count)
    enemies = {}
    for _ = 1, count do spawnOneEnemy() end
end

-- ── Boss ───────────────────────────────────────────────────────────
local function spawnBoss()
    local bx = math.random(10, COLS - 10)
    local by = math.random(5, ROWS - 5)
    boss         = newSnake(bx, by, "right", 20, 250)
    boss.isBoss  = true
    boss.points  = 500
end

local function updateBossAI(delta)
    if not boss or not boss.alive or not player or not player.alive then return end
    boss.aiTimer += delta
    if boss.aiTimer > 600 then
        boss.aiTimer = 0
        local ph = snakeHead(player)
        local bh = snakeHead(boss)
        local dx, dy = ph.x - bh.x, ph.y - bh.y
        if math.abs(dx) > math.abs(dy) then
            snakeTurnTo(boss, dx > 0 and "right" or "left")
        else
            snakeTurnTo(boss, dy > 0 and "down" or "up")
        end
    end
end

local function updateEnemyAI(e, delta)
    e.aiTimer += delta
    local interval = 800 + math.random() * 400
    if e.aiTimer > interval then
        e.aiTimer = 0
        if math.random() < 0.3 and player then
            local ph = snakeHead(player)
            local eh = snakeHead(e)
            local dx, dy = ph.x - eh.x, ph.y - eh.y
            if math.abs(dx) > math.abs(dy) then
                snakeTurnTo(e, dx > 0 and "right" or "left")
            else
                snakeTurnTo(e, dy > 0 and "down" or "up")
            end
        else
            snakeTurnTo(e, DIRS[math.random(#DIRS)])
        end
    end
end

-- ── Collisions ─────────────────────────────────────────────────────
local function killPlayer()
    if not player.alive then return end
    player.alive     = false
    gameOverPending  = true
    gameOverTimer    = 800
    spawnParticles(snakeHead(player).x, snakeHead(player).y, 20)
end

local function eatSection(enemy, idx)
    enemy.eatProgress += 1
    score += 10
    spawnParticles(enemy.segments[idx].x, enemy.segments[idx].y, 3)
    table.remove(enemy.segments, idx)
    if #enemy.segments <= 1 then
        score += enemy.points
        spawnParticles(snakeHead(enemy).x, snakeHead(enemy).y, 10)
        -- Grow player by one segment
        if player and player.alive then
            local tail = player.segments[#player.segments]
            table.insert(player.segments, { x = tail.x, y = tail.y })
        end
        enemy.alive = false
        if enemy == boss then boss = nil ; score += 500 end
    end
end

local function checkCollisions()
    if not player or not player.alive then return end
    local ph  = snakeHead(player)
    local all = {}
    for _, e in ipairs(enemies) do table.insert(all, e) end
    if boss then table.insert(all, boss) end

    for _, e in ipairs(all) do
        if e.alive then
            -- Eat tail sections from the back
            for i = #e.segments, 2, -1 do
                local seg = e.segments[i]
                if seg.x == ph.x and seg.y == ph.y then
                    eatSection(e, i) ; return
                end
            end
            -- Wide bite: check adjacent tiles too
            if player.wideBite then
                local nb = {
                    { x = ph.x+1, y = ph.y }, { x = ph.x-1, y = ph.y },
                    { x = ph.x,   y = ph.y+1 }, { x = ph.x, y = ph.y-1 },
                }
                for _, n in ipairs(nb) do
                    for i = #e.segments, 2, -1 do
                        local seg = e.segments[i]
                        if seg.x == n.x and seg.y == n.y then
                            eatSection(e, i) ; return
                        end
                    end
                end
            end
            -- Head-on collision
            local eh = snakeHead(e)
            if eh.x == ph.x and eh.y == ph.y then
                if not player.shielded then killPlayer() end
                return
            end
        end
    end

    -- Self collision (skip first 4 segments)
    for i = 5, #player.segments do
        local seg = player.segments[i]
        if seg.x == ph.x and seg.y == ph.y then
            if not player.shielded then killPlayer() end
            return
        end
    end
end

-- ── Crank update ───────────────────────────────────────────────────
local function updateCrank(delta)
    -- getCrankChange() returns signed degrees; we want absolute rotation
    local change = math.abs(playdate.getCrankChange())
    crankMeter = math.min(100, crankMeter + change * CRANK_SCALE)
    if crankMeter > 0 then
        crankMeter = math.max(0, crankMeter - CRANK_DECAY_RATE * delta / 1000)
    end
    crankBoosting = crankMeter >= CRANK_BOOST_MIN
end

-- ── HUD ────────────────────────────────────────────────────────────
local function drawHUD()
    local now = playdate.getCurrentTimeMilliseconds()

    gfx.setColor(gfx.kColorWhite)

    -- Score (top-left)
    gfx.drawText("SCORE " .. score, 4, 2)

    -- Timer (top-center)
    local mins = math.floor(timeLeft / 60)
    local secs = math.floor(timeLeft % 60)
    local tStr = string.format("%d:%02d", mins, secs)
    if bossWarning and (now // 300) % 2 == 0 then
        gfx.drawText("*!! BOSS INCOMING !!*", centeredX("!! BOSS INCOMING !!"), 2)
    else
        gfx.drawText(tStr, centeredX(tStr), 2)
    end

    -- Ability bar (top-right)
    if player and player.charDef then
        local barW = 38
        local barX = W - 4 - barW
        if player.abilityTimer > 0 then
            local pct = 1 - player.abilityTimer / player.charDef.abilityCooldown
            gfx.setColor(gfx.kColorWhite)
            gfx.drawRect(barX, 4, barW, 5)
            gfx.fillRect(barX, 4, math.floor(barW * pct), 5)
            gfx.drawText("CD", W - 20, 10)
        else
            gfx.drawText("Ⓐ RDY", W - 36, 2)
        end
        if player.abilityActive then
            local label = "*" .. player.charDef.desc:upper() .. "!*"
            gfx.drawText(label, centeredX(player.charDef.desc:upper() .. "!"), H - 16)
        end
    end

    -- Crank boost meter (bottom-left)
    local crankBarW = 36
    gfx.setColor(gfx.kColorWhite)
    gfx.drawRect(4, H - 14, crankBarW, 5)
    if crankMeter > 0 then
        gfx.fillRect(4, H - 14, math.floor(crankBarW * crankMeter / 100), 5)
    end
    if crankBoosting and (now // 120) % 2 == 0 then
        gfx.drawText("*BOOST!*", 4, H - 24)
    elseif not crankBoosting then
        gfx.drawText("CRANK", 4, H - 24)
    end

    -- Enemy count (bottom-right)
    local alive = 0
    for _, e in ipairs(enemies) do if e.alive then alive += 1 end end
    gfx.drawText("SNAKES " .. alive, W - 58, H - 12)

    -- Boss health bar (bottom-center)
    if boss and boss.alive then
        local pct  = #boss.segments / 20
        local barW = 80
        local barX = W // 2 - barW // 2
        gfx.setColor(gfx.kColorWhite)
        gfx.drawRect(barX, H - 10, barW, 5)
        gfx.fillRect(barX, H - 10, math.floor(barW * pct), 5)
        gfx.drawText("*BOSS*", centeredX("BOSS"), H - 22)
    end

    -- Shield ring around player head
    if player and player.shielded then
        local ph = snakeHead(player)
        gfx.setColor(gfx.kColorWhite)
        gfx.drawRect(ph.x * GRID - 1, ph.y * GRID - 1, GRID + 2, GRID + 2)
    end
end

-- ── Title screen ───────────────────────────────────────────────────
local function drawTitle()
    gfx.setColor(gfx.kColorBlack)
    gfx.fillRect(0, 0, W, H)
    gfx.setColor(gfx.kColorWhite)
    gfx.drawRect(2, 2, W - 4, H - 4)

    gfx.drawText("*SNAKE CLASH*", centeredX("SNAKE CLASH"), 50)
    gfx.drawText("EAT OR BE EATEN", centeredX("EAT OR BE EATEN"), 70)

    -- Animated snake dots
    local t = playdate.getCurrentTimeMilliseconds() // 600
    for i = 0, 7 do
        local x = 60 + i * 35
        local y = 100 + math.floor(math.sin(t + i) * 8)
        if i == 0 then gfx.fillRect(x - 4, y - 4, 8, 8)
        else gfx.fillRect(x - 3, y - 3, 6, 6) end
    end

    gfx.drawText("PRESS Ⓐ TO START", centeredX("PRESS Ⓐ TO START"), 140)
    gfx.drawText("3 MIN UNTIL THE BOSS", centeredX("3 MIN UNTIL THE BOSS"), 158)
    gfx.drawText("EAT ENEMY TAILS TO SCORE", centeredX("EAT ENEMY TAILS TO SCORE"), 170)
    gfx.drawText("CRANK FOR SPEED BOOST", centeredX("CRANK FOR SPEED BOOST"), 182)

    if #highScores > 0 then
        local hs = highScores[1]
        gfx.drawText("HI: " .. hs.score .. " " .. hs.name, centeredX("HI: XXXXXX XXXXXX"), 200)
    end

    if playdate.buttonJustPressed(playdate.kButtonA) then state = "select" end
end

-- ── Character select ───────────────────────────────────────────────
local function drawSelect()
    gfx.setColor(gfx.kColorBlack)
    gfx.fillRect(0, 0, W, H)
    gfx.setColor(gfx.kColorWhite)
    gfx.drawRect(2, 2, W - 4, H - 4)
    gfx.drawText("*CHOOSE YOUR SNAKE*", centeredX("CHOOSE YOUR SNAKE"), 8)

    local boxW, boxH  = 100, 140
    local totalW      = #CHARACTERS * boxW + (#CHARACTERS - 1) * 10
    local startX      = (W - totalW) // 2

    for i, ch in ipairs(CHARACTERS) do
        local bx  = startX + (i - 1) * (boxW + 10)
        local by  = 24
        local sel = selectedChar == i

        gfx.setColor(gfx.kColorWhite)
        if sel then
            gfx.fillRect(bx, by, boxW, boxH)
            gfx.setImageDrawMode(gfx.kDrawModeFillBlack)
        else
            gfx.drawRect(bx, by, boxW, boxH)
            gfx.setImageDrawMode(gfx.kDrawModeCopy)
        end

        gfx.drawText("*" .. ch.headChar .. "*",  bx + boxW // 2 - 5, by + 8)
        gfx.drawText("*" .. ch.name .. "*",      bx + 4,             by + 28)
        gfx.drawText(ch.desc,                     bx + 4,             by + 44)
        gfx.drawText(ch.tip,                      bx + 4,             by + 60)

        local spdDots = ch.baseSpeed <= 200 and "SPD ●●●"
                     or ch.baseSpeed <= 220 and "SPD ●●○"
                     or                         "SPD ●○○"
        gfx.drawText(spdDots, bx + 4, by + boxH - 16)
        gfx.setImageDrawMode(gfx.kDrawModeCopy)
    end

    gfx.setColor(gfx.kColorWhite)
    gfx.drawText("←→ SELECT   Ⓐ START", centeredX("←→ SELECT   Ⓐ START"), H - 14)

    if playdate.buttonJustPressed(playdate.kButtonLeft) then
        selectedChar = ((selectedChar - 2) % #CHARACTERS) + 1
    end
    if playdate.buttonJustPressed(playdate.kButtonRight) then
        selectedChar = (selectedChar % #CHARACTERS) + 1
    end
    if playdate.buttonJustPressed(playdate.kButtonA) then
        startGame(selectedChar)
    end
end

-- ── Name entry (d-pad on Playdate) ────────────────────────────────
local function updateNameEntry()
    if playdate.buttonJustPressed(playdate.kButtonUp) then
        nameCursorPos = (nameCursorPos % #NAME_CHARS) + 1
    end
    if playdate.buttonJustPressed(playdate.kButtonDown) then
        nameCursorPos = ((nameCursorPos - 2) % #NAME_CHARS) + 1
    end
    if playdate.buttonJustPressed(playdate.kButtonRight) and #nameInput < 6 then
        nameInput = nameInput .. NAME_CHARS:sub(nameCursorPos, nameCursorPos)
    end
    if playdate.buttonJustPressed(playdate.kButtonLeft) and #nameInput > 0 then
        nameInput = nameInput:sub(1, -2)
    end
    if playdate.buttonJustPressed(playdate.kButtonA) and #nameInput > 0 then
        addScore(nameInput, score)
        enterNameMode = false
    end
end

local function drawLeaderboardList(yStart, maxRows)
    local show = math.min(#highScores, maxRows or 5)
    for i = 1, show do
        local hs    = highScores[i]
        local entry = string.format("%d. %-6s %d", i, hs.name, hs.score)
        gfx.drawText(entry, centeredX(entry), yStart + (i - 1) * 13)
    end
end

-- ── Game over screen ───────────────────────────────────────────────
local function drawGameOver()
    gfx.setColor(gfx.kColorBlack)
    gfx.fillRect(0, 0, W, H)
    gfx.setColor(gfx.kColorWhite)
    gfx.drawRect(2, 2, W - 4, H - 4)

    gfx.drawText("*GAME OVER*",    centeredX("GAME OVER"),    50)
    gfx.drawText("SCORE: " .. score, centeredX("SCORE: " .. score), 68)

    if enterNameMode then
        gfx.drawText("*NEW HIGH SCORE!*",          centeredX("NEW HIGH SCORE!"),          92)
        gfx.drawText("↑↓ LETTER  → ADD  Ⓐ DONE", centeredX("↑↓ LETTER  → ADD  Ⓐ DONE"), 108)
        local curLetter = NAME_CHARS:sub(nameCursorPos, nameCursorPos)
        local display   = nameInput .. "_" .. curLetter
        gfx.drawText("*" .. display .. "*", centeredX(display), 126)
        updateNameEntry()
    else
        gfx.drawText("*HIGH SCORES*", centeredX("HIGH SCORES"), 94)
        drawLeaderboardList(110, 5)
        gfx.drawText("Ⓐ PLAY AGAIN", centeredX("Ⓐ PLAY AGAIN"), H - 14)
        if playdate.buttonJustPressed(playdate.kButtonA) then state = "select" end
    end
end

-- ── Full leaderboard screen ────────────────────────────────────────
local function drawLeaderboardScreen()
    gfx.setColor(gfx.kColorBlack)
    gfx.fillRect(0, 0, W, H)
    gfx.setColor(gfx.kColorWhite)
    gfx.drawRect(2, 2, W - 4, H - 4)
    gfx.drawText("*LEADERBOARD*", centeredX("LEADERBOARD"), 8)
    if #highScores == 0 then
        gfx.drawText("NO SCORES YET", centeredX("NO SCORES YET"), 100)
    else
        drawLeaderboardList(28, 10)
    end
    gfx.drawText("Ⓐ BACK", centeredX("Ⓐ BACK"), H - 14)
    if playdate.buttonJustPressed(playdate.kButtonA) then state = "title" end
end

-- ── Grid background ────────────────────────────────────────────────
local function drawGrid()
    gfx.setColor(gfx.kColorBlack)
    gfx.fillRect(0, 0, W, H)
end

-- ── Game init ──────────────────────────────────────────────────────
function startGame(charIdx)
    local def      = CHARACTERS[charIdx]
    score          = 0
    timeLeft       = GAME_DURATION
    bossSpawned    = false
    bossWarning    = false
    boss           = nil
    particles      = {}
    crankMeter     = 0
    crankBoosting  = false
    gameOverPending = false
    enterNameMode  = false
    player = newSnake(COLS // 2, ROWS // 2, "right", 4, def.baseSpeed, true, def)
    spawnEnemies(4)
    state = "play"
end

local function endGame()
    local minScore = (#highScores < 10) and 0 or (highScores[10] and highScores[10].score or 0)
    if score > minScore then
        enterNameMode = true
        nameInput     = ""
        nameCursorPos = 1
    end
    state = "gameover"
end

-- ── Main loop ──────────────────────────────────────────────────────
function playdate.update()
    local now   = playdate.getCurrentTimeMilliseconds()
    local delta = math.min(now - lastTime, 100)
    lastTime    = now

    if state == "title"       then drawTitle()           ; return end
    if state == "select"      then drawSelect()          ; return end
    if state == "gameover"    then
        drawGrid() ; drawParticles() ; drawGameOver()    ; return
    end
    if state == "leaderboard" then drawLeaderboardScreen(); return end

    -- ── Play ──────────────────────────────────────────────────────
    updateCrank(delta)

    if player and player.alive then
        if playdate.buttonJustPressed(playdate.kButtonUp)    then snakeTurnTo(player, "up")    end
        if playdate.buttonJustPressed(playdate.kButtonDown)  then snakeTurnTo(player, "down")  end
        if playdate.buttonJustPressed(playdate.kButtonLeft)  then snakeTurnTo(player, "left")  end
        if playdate.buttonJustPressed(playdate.kButtonRight) then snakeTurnTo(player, "right") end
        if playdate.buttonJustPressed(playdate.kButtonA) or
           playdate.buttonJustPressed(playdate.kButtonB) then
            useAbility(player)
        end
    end

    -- Death animation hold
    if gameOverPending then
        gameOverTimer -= delta
        updateParticles(delta)
        drawGrid()
        for _, e in ipairs(enemies) do drawSnake(e) end
        if boss then drawSnake(boss) end
        drawParticles()
        drawHUD()
        if gameOverTimer <= 0 then
            gameOverPending = false
            endGame()
        end
        return
    end

    -- Timer
    timeLeft -= delta / 1000
    if timeLeft < 0 then timeLeft = 0 end
    if not bossSpawned and timeLeft <= BOSS_WARN then bossWarning = true end
    if not bossSpawned and timeLeft <= 0 then
        bossSpawned = true
        bossWarning = false
        spawnBoss()
    end

    -- Respawn enemies
    local aliveCount = 0
    for _, e in ipairs(enemies) do if e.alive then aliveCount += 1 end end
    if aliveCount < 3 then spawnOneEnemy() end

    -- Update snakes
    if player then updateSnake(player, delta) end
    for _, e in ipairs(enemies) do
        if e.alive then updateEnemyAI(e, delta) ; updateSnake(e, delta) end
    end
    if boss and boss.alive then updateBossAI(delta) ; updateSnake(boss, delta) end

    checkCollisions()
    updateParticles(delta)

    -- Draw
    drawGrid()
    for _, e in ipairs(enemies) do drawSnake(e) end
    if boss then drawSnake(boss) end
    if player then drawSnake(player) end
    drawParticles()
    drawHUD()
end

-- ── Init ───────────────────────────────────────────────────────────
highScores = loadScores()
lastTime   = playdate.getCurrentTimeMilliseconds()
math.randomseed(playdate.getSecondsSinceEpoch())
