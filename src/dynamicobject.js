const { JPixi } = require("./lib/jpixi");
const { appConf } = require("./lib/jpixi_config");
const { World, LimitTypes } = require("./world");
const { BaseObject, BaseObjectColl, ColliderTypes, Prop, DynamicTypes } = require("./baseobject");
const { StaticObject } = require("./staticobject");
const { Grid, Cell } = require("./grid");
const { ai, player, site } = require("./config");
const SAT = require("sat");
const { Target } = require("./target");


///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// DYNAMIC OBJECT CLASS
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class DynamicObject extends BaseObjectColl {
    /**
     * 
     * @param {string} resourcePath path to image file to use as sprite.
     * @param {Number} posX postition X in world container.
     * @param {Number} posY postition Y in world container.
     * @param {Number} width width of sprite.
     * @param {Number} height height of sprite.
     * @param {World} world what world this object is in.
     */
    constructor(resourcePath, world, posX, posY, width, height, colliderType = ColliderTypes.Circle) {
        super(world, posX, posY, width, height, colliderType);

        if (colliderType == ColliderTypes.BoxCentered || colliderType == ColliderTypes.Circle)
            this.sprite = JPixi.Sprite.Create(resourcePath, this.prop.x, this.prop.y, this.prop.width, this.prop.height, this.world.layerMiddle, true);
        else
            this.sprite = JPixi.Sprite.Create(resourcePath, this.prop.x, this.prop.y, this.prop.width, this.prop.height, this.world.layerMiddle, false);

        this.updateRate = 1;
        this.directionUpdateRate = 1;

        this.firstPass = true;
        this.lastWorldCount = 0;

        this.speed = 0;

        this.target = new Target(this);

        // Track current cells(s) and surrounding cells.
        this.cellEdgeDist = 0; // Counts down with movement and re-checks when 0 or lower.
        this.surroundingCells = [];
        this.cellsActive = [];
        for (var i = 0; i < this.world.grid.cellCount; i++)
            this.cellsActive[i] = false;

        this.timeOutList = []; /// Stores setTimeouts for easy cleaning on destroy
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // TIMEOUT CALLBACKS, TRACK FOR CLEARING UPON DESTORY AND AVOID UNDEFINED.
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /// Add a setTimeout(()=>{},Number});
    AddToTimeOutList(timeOut) {
        this.timeOutList.push(timeOut);
    }

    /// Remove all timeouts pending
    ResetTimeOutList(doReset = true) {
        if (doReset) this.Reset();

        for (var i = this.timeOutList.length - 1; i > -1; i--) {
            clearTimeout(this.timeOutList[i]);
        }

        this.timeOutList = [];
    }

    Reset() {

    }


    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // DESTROY
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    Destroy() {
        this.ResetTimeOutList(false);

        this.target.object.UnSubscribeAll(this);
        this.target = undefined;

        this.collider = undefined;
        this.prop = undefined;
        this.sprite = undefined;

        this.Publish("OnDestroyed");
        this.eventTopics = [];
    }


    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // OBJECT UPDATE
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    FirstPass() {
        this.firstPass = false;

        if (this.lastWorldCount != this.world.count) {
            this.firstPass = true;
            this.lastWorldCount = this.world.count;
        }
    }

    UpdateMovement(cell) {
        if (!this.firstPass) return;

        this.updateRate = cell.updateRate;

        if (cell.FramesBetweenUpdates(this.directionUpdateRate)) {
            this.target.UpdateDirectionAndDistance();
        }

        if (this.UpdateProp()) {
            this.AvoidOutOfBounds();
            this.SyncSpriteAndColliderWithProp();
        }

        this.UpdateActiveCells(cell);
    }

    UpdateProp() {
        if (this.target.atDestination || this.speed == 0) return false;

        var prevX = this.prop.x;
        var prevY = this.prop.y;

        this.prop.x += this.target.direction.x * this.speed * this.updateRate * this.world.delta;
        this.prop.y += this.target.direction.y * this.speed * this.updateRate * this.world.delta;

        if (this.target.direction.x != 0) this.cellEdgeDist -= Math.abs(prevX - this.prop.x);
        if (this.target.direction.y != 0) this.cellEdgeDist -= Math.abs(prevY - this.prop.y);

        return true;
    }

    SyncSpriteAndColliderWithProp() {
        this.sprite.position.set(this.prop.x, this.prop.y);
        this.sprite.width = this.prop.width;
        this.sprite.height = this.prop.height;
        this.collider.Position(this.prop.x, this.prop.y, this.prop.width, this.prop.height);
    }

    UpdateActiveCells(cell) {
        if (this.dynamicType === DynamicTypes.Player && cell.FramesBetweenUpdates(player.cellUpdateRate)) {
            this.world.grid.AddPlayerToCell(this);
        }

        else if (cell.FramesBetweenUpdates(ai.cellUpdateRate)) {
            if (this.dynamicType === DynamicTypes.Foe) this.world.grid.AddFoeToCell(this);
            else this.world.grid.AddFriendToCell(this);
        }
    }

    AvoidOutOfBounds(cell) {
        if (this.prop.x > appConf.worldWidth - this.prop.width / 2) this.prop.x = appConf.worldWidth - this.prop.width / 2;
        else if (this.prop.x < this.prop.width / 2) this.prop.x = this.prop.width / 2;
        if (this.prop.y > appConf.worldHeight - this.prop.height / 2) this.prop.y = appConf.worldHeight - this.prop.height / 2;
        else if (this.prop.y < this.prop.height / 2) this.prop.y = this.prop.height / 2;
    }


    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // HELPERS
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /**
     * Get the closest object in this and the surrounding cells. Distance is sqr magnitude!
     * 
     * @param {DynamicTypes} dynamicType 
     */
    GetClosestDynamicObject(dynamicType) {
        var distance;
        var objAndDist = { found: false, object: undefined, distance: undefined };
        var closest;

        for (var i = 0; i < this.surroundingCells.length; i++) {
            var index = this.surroundingCells[i];
            var cell = this.world.grid.cells[index];

            if (dynamicType == DynamicTypes.Friend) closest = this.world.Closest(this, cell.friends);
            else if (dynamicType == DynamicTypes.Foe) closest = this.world.Closest(this, cell.foes);
            else closest = this.world.Closest(this, cell.player);

            if (closest.found && (closest.distance < distance || distance === undefined)) {
                distance = closest.distance;
                objAndDist = closest;
            }
        }

        return objAndDist;
    }
}


///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// PLAYER EXTENSION
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class Player extends DynamicObject {

    /**
     * 
     * @param {string} resourcePath 
     * @param {World} world 
     * @param {Number} posX 
     * @param {Number} posY
     * @param {Number} width
     * @param {Number} height
     */
    constructor(resourcePath, world, posX, posY, width, height, colliderType = ColliderTypes.Circle) {
        super(resourcePath, world, posX, posY, width, height, colliderType);
        this.world.grid.AddPlayerToCell(this);
        this.dynamicType = DynamicTypes.Player;

        this.speed = player.speed;

        this.sprite.parent.removeChild(this.sprite);
        this.sprite.setParent(this.world.layerPlayer);
        this.sprite.tint = 0x0000FF;
        this.sprite.alpha = 1;

        this.playerTarget = new BaseObject(this.world, this.prop.x, this.prop.y, 12, 12);
        this.playerTarget.sprite = JPixi.Sprite.Create(resourcePath,
            this.playerTarget.prop.x, this.playerTarget.prop.y,
            this.playerTarget.prop.width, this.playerTarget.prop.height,
            world.layerTopDecals, true
        );
        this.playerTarget.sprite.tint = 0x2F2FFF;
        this.playerTarget.sprite.alpha = 0.7;

        this.target.SetTarget(this.playerTarget);

        this.speed = 0;

        this.directionUpdateRate = player.directionUpdateRate;

        /**@type {PIXI.Sprite} */
        this.inputDetection = new JPixi.Sprite.Create(site.img + "black1px.png", 0, 0, appConf.worldWidth, appConf.worldHeight, this.world.layerBottom, false);
        this.inputDetection.alpha = 0;
        this.inputDetection.interactive = true;
        this.inputDetection.on("pointerdown", event => { event.stopPropagation(); this.OnPointerDown(event); });
        this.inputDetection.on("pointerup", event => { event.stopPropagation(); this.OnPointerUp(event); });

        this.eventData = undefined;

        this.friends = [];

        this.isMunch = false;
        this.monsterKillCount = 0;
    }

    OnPointerDown(event) {
        if (this.IsDestroyed()) return;

        this.eventData = event.data;
        this.speed = 1;
    }

    OnPointerUp(event) {
        if (this.IsDestroyed()) return;

        this.speed = 0;

        this.playerTarget.prop.x = this.prop.x;
        this.playerTarget.prop.y = this.prop.y;
        this.playerTarget.sprite.position.set(this.prop.x, this.prop.y);
    }


    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // OBJECT UPDATE
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    Update(cell) {
        // Move player towards mouse/touch position.
        if (this.eventData != undefined && this.speed > 0) {
            var localPoint = this.eventData.getLocalPosition(this.world.container);

            if (this.speed != 0 && this.target.distance > 20000) this.speed = 6;
            else if (this.speed != 0 && this.target.distance > 20000) this.speed = 5;
            else if (this.speed != 0 && this.target.distance > 14000) this.speed = 4;
            else if (this.speed != 0 && this.target.distance > 8000) this.speed = 3;
            else if (this.speed != 0 && this.target.distance > 2000) this.speed = 2;
            else if (this.speed != 0) this.speed = player.speed;

            this.playerTarget.prop.x = localPoint.x;
            this.playerTarget.prop.y = localPoint.y;
            this.playerTarget.sprite.position.set(localPoint.x, localPoint.y);
        }

        if (this.IsDestroyed()) return;

        this.UpdateMovement(cell);
    }


    Reset() {
        this.sprite.alpha = 1;
        this.sprite.tint = 0x0000FF;
        this.isMunch = false;

        for (var i = this.friends.length - 1; i > -1; i--) {
            this.friends[i].Reset();
        }

        super.Reset();
    }

    Destroy() {
        this.world.layerPlayer.removeChild(this.sprite);
        this.world.layerTopDecals.removeChild(this.playerTarget.sprite);
        this.playerTarget = undefined;

        for (var i = this.friends.length - 1; i > -1; i--)
            this.friends[i].InSuperNova();

        this.world.gameManager.Trigger("GameOver");

        super.Destroy();
    }

    AddFriend() {
        var index = this.friends.length;
        this.friends[index] = new Friend(site.img + "white1px.png", this.world, this.prop.x, this.prop.y, 8, 8);

        if (index <= 0) {
            this.friends[index].target.SetTarget(this);
            this.friends[index].nr1 = true;
            this.friends[index].prop.width += 12;
            this.friends[index].prop.height += 12;
        }
        else {
            this.friends[index].target.SetTarget(this.friends[index - 1]);
        }
    }

    PUOutOfPhase() {
        this.ResetTimeOutList();

        this.sprite.alpha = 0.2;
        this.sprite.tint = 0xFF00FF;

        this.AddToTimeOutList(setTimeout(() => { this.sprite.alpha = 0.2; }, 3000));
        this.AddToTimeOutList(setTimeout(() => { this.sprite.alpha = 0.8; }, 3750));
        this.AddToTimeOutList(setTimeout(() => { this.sprite.alpha = 0.2; }, 4250));
        this.AddToTimeOutList(setTimeout(() => { this.sprite.alpha = 0.8; }, 4500));
        this.AddToTimeOutList(setTimeout(() => { this.sprite.alpha = 0.2; }, 4750));
        this.AddToTimeOutList(setTimeout(() => { this.Reset(); }, 5000));
    }

    PUFreeze() {
        this.ResetTimeOutList();

        for (var i = this.friends.length - 1; i > -1; i--) {
            this.friends[i].InFreeze();
        }
    }

    PURepel() {
        this.ResetTimeOutList();

        for (var i = this.friends.length - 1; i > -1; i--) {
            this.friends[i].InRepel();
        }
    }

    PUMunch() {
        this.ResetTimeOutList();

        this.sprite.alpha = 0.75;
        this.sprite.tint = 0xAF1A4F;
        this.isMunch = true;

        for (var i = this.friends.length - 1; i > -1; i--) {
            this.friends[i].InScared();
        }

        this.AddToTimeOutList(setTimeout(() => { this.sprite.alpha = 0.2; }, 3000));
        this.AddToTimeOutList(setTimeout(() => { this.sprite.alpha = 0.8; }, 3750));
        this.AddToTimeOutList(setTimeout(() => { this.sprite.alpha = 0.2; }, 4250));
        this.AddToTimeOutList(setTimeout(() => { this.sprite.alpha = 0.8; }, 4500));
        this.AddToTimeOutList(setTimeout(() => { this.sprite.alpha = 0.2; }, 4750));
        this.AddToTimeOutList(setTimeout(() => { this.Reset(); }, 5000));
    }
}


///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// AI EXTENSION
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class AI extends DynamicObject {

    /**
     * 
     * @param {string} resourcePath 
     * @param {World} world 
     * @param {Number} posX 
     * @param {Number} posY
     * @param {Number} width
     * @param {Number} height
     */
    constructor(resourcePath, world, posX, posY, width, height, colliderType = ColliderTypes.Circle) {
        super(resourcePath, world, posX, posY, width, height, colliderType);

        this.directionUpdateRate = ai.directionUpdateRate;
    }

    Destroy() {
        this.world.layerMiddle.removeChild(this.sprite);
        super.Destroy();
    }
}


///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// FRIEND EXTENSION
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class Friend extends AI {

    /**
     * 
     * @param {string} resourcePath 
     * @param {World} world 
     * @param {Number} posX 
     * @param {Number} posY
     * @param {Number} width
     * @param {Number} height
     */
    constructor(resourcePath, world, posX, posY, width, height, colliderType = ColliderTypes.Circle) {
        super(resourcePath, world, posX, posY, width, height, colliderType);
        this.world.grid.AddFriendToCell(this);
        this.dynamicType = DynamicTypes.Friend;

        this.speed = ai.friend.speed;

        this.sprite.tint = 0xFFFFFF * Math.random();
        this.sprite.alpha = 0.15;

        this.AddToTimeOutList(setTimeout(() => { this.sprite.alpha = 0.25; }, 500));
        this.AddToTimeOutList(setTimeout(() => { this.sprite.alpha = 0.5; this.sprite.tint = 0xFF0000 * Math.random(); }, 4000));
        this.AddToTimeOutList(setTimeout(() => { this.Reset(); }, 5000));

        this.nr1 = false;
    }


    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // OBJECT UPDATE
    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    Update(cell) {
        if (this.nr1 && this.target.distance < 40000 && this.sprite.alpha == 1) this.sprite.tint = 0xFF0000;
        else if (!this.gameOver && !this.target.reverse) this.sprite.tint = 0xFFFFFF * Math.random();

        if (this.target.reverse && !this.nr1) {
            this.sprite.alpha = 0.2;
            this.sprite.tint = 0xFFFF00;
        }

        if (cell.FramesBetweenUpdates(ai.interactUpdateRate)) {
            var player = cell.player[0];
            if (player != undefined && this.world.Collide(this.collider, player.collider)) this.CollisionPlayer(player);
        }

        if (this.IsDestroyed()) return;

        this.UpdateMovement(cell);
    }

    CollisionPlayer(player) {
        if (player.isMunch) {
            if (this.nr1 && this.sprite.alpha >= 0.8) {
                player.monsterKillCount++;
                this.world.gameManager.Trigger("UpdateScore", player.friends.length * 10 * player.monsterKillCount);

                for (var i = 0; i < player.friends.length; i++) {
                    player.friends[i].Destroy();
                }

                player.friends = [];
            }
            else if (this.sprite.alpha >= 0.2 && !this.nr1) {
                this.world.gameManager.Trigger("UpdateScore", 10);

                var index = -1;

                for (var i = 0; i < player.friends.length; i++) {
                    index = player.friends.indexOf(this);
                    if (index > -1) player.friends.splice(index, 1);
                }

                for (var i = 1; i < player.friends.length; i++) {
                    player.friends[i].target.SetTarget(player.friends[i - 1]);
                }

                this.Destroy();
            }

            return;
        }

        if (player.sprite.alpha === 1 && this.sprite.alpha === 1) player.Destroy();
    }

    Reset() {
        this.target.reverse = false;
        this.AddToTimeOutList(setTimeout(() => { this.sprite.alpha = 0.8; }, 100));
        this.AddToTimeOutList(setTimeout(() => { this.sprite.alpha = 1; }, 500));
        this.sprite.tint = 0xFFFFFF * Math.random();
        this.speed = ai.friend.speed;

        super.Reset();
    }

    InRepel() {
        this.ResetTimeOutList();

        if (this.nr1) this.speed = 0.1;

        this.target.reverse = true;
        this.sprite.alpha = 0.2;
        this.sprite.tint = 0xFFFF00;

        this.AddToTimeOutList(setTimeout(() => { this.target.reverse = false; }, 2500));
        this.AddToTimeOutList(setTimeout(() => { this.Reset(); }, 5000));
    }

    InScared() {
        this.ResetTimeOutList();

        this.speed = ai.friend.speed * 1.25;

        if (this.nr1) {
            this.target.reverse = true;
            this.sprite.tint = 0x0000FF;
            this.sprite.alpha = 0.8;
        }
    }

    InSuperNova() {
        if (!this.nr1) return;

        this.ResetTimeOutList();

        var onDeath = new BaseObject(this.world, -this.world.container.x, -this.world.container.y, 0, 0);
        var count = 0;

        this.target.SetTarget(onDeath);
        this.sprite.alpha = 0.1;
        this.speed = 1;
        this.sprite.parent.removeChild(this.sprite);
        this.sprite.setParent(this.world.layerTopDecals);
        this.sprite.anchor.set(0.5, 0.5);
        this.sprite.tint = 0xFFCFEF;
        this.gameOver = true;

        setInterval(() => {
            count++;
            if (count <= 20) {
                onDeath.prop.y += 1;
                onDeath.prop.x += 2;
            }
            else if (count > 20 && count <= 40) {
                onDeath.prop.y += 2;
                onDeath.prop.x -= 1;
            }
            else if (count > 40 && count <= 60) {
                onDeath.prop.y -= 1;
                onDeath.prop.x -= 2;
            }
            else if (count > 60) {
                onDeath.prop.y -= 2;
                onDeath.prop.x += 1;
            }

            if (count >= 80) count = 0;

            this.sprite.alpha += 0.00085;
            this.prop.width += 0.5;
            this.prop.height += 0.5;
            this.sprite.rotation += 0.02;

            if (this.sprite.alpha <= 0.99) this.sprite.tint = 0xFFCFEF * Math.random();
            else this.sprite.tint = 0xFFEFF0;
        }, 1);
    }

    InFreeze() {
        this.ResetTimeOutList();

        this.sprite.alpha = 0.2;
        this.speed = 0.8;

        /**
         * Structured like this to improve performance when freezing a long tail.
         */
        this.AddToTimeOutList(setTimeout(() => {
            this.speed = 0.1;
            this.AddToTimeOutList(setTimeout(() => {
                this.speed = 0.01; this.sprite.alpha = 1;
                this.AddToTimeOutList(setTimeout(() => {
                    this.sprite.alpha = 0.2;
                    this.AddToTimeOutList(setTimeout(() => {
                        this.sprite.alpha = 1;
                        this.AddToTimeOutList(setTimeout(() => {
                            this.sprite.alpha = 0.2;
                            this.AddToTimeOutList(setTimeout(() => {
                                this.sprite.alpha = 1;
                                this.AddToTimeOutList(setTimeout(() => {
                                    this.sprite.alpha = 0.2;
                                    this.AddToTimeOutList(setTimeout(() => {
                                        this.Reset();
                                    }, 250));
                                }, 250));
                            }, 250));
                        }, 500));
                    }, 750));
                }, 2500));
            }, 250));
        }, 250));
    }
}


///////////////////////////////////////////////////////////////////////////////
// MODULE EXPORT
///////////////////////////////////////////////////////////////////////////////

module.exports = {
    Player,
    Friend
}