/*global define*/
define([
        '../Core/AssociativeArray',
        '../Core/Color',
        '../Core/ColorGeometryInstanceAttribute',
        '../Core/defined',
        '../Core/ShowGeometryInstanceAttribute',
        '../Scene/PerInstanceColorAppearance',
        '../Scene/Primitive',
        '../Scene/PrimitiveState'
    ], function(
        AssociativeArray,
        Color,
        ColorGeometryInstanceAttribute,
        defined,
        ShowGeometryInstanceAttribute,
        PerInstanceColorAppearance,
        Primitive,
        PrimitiveState) {
    "use strict";

    var Batch = function(primitives, translucent) {
        this.translucent = translucent;
        this.primitives = primitives;
        this.createPrimitive = false;
        this.primitive = undefined;
        this.oldPrimitive = undefined;
        this.geometry = new AssociativeArray();
        this.updaters = new AssociativeArray();
        this.updatersWithAttributes = new AssociativeArray();
        this.attributes = new AssociativeArray();
        this.subscriptions = new AssociativeArray();
        this.toggledObjects = new AssociativeArray();
        this.itemsToRemove = [];
    };

    Batch.prototype.uiShowChanged = function(entity, propertyName, value, oldValue) {
        if (propertyName === 'uiShow' && value !== oldValue) {
            this.toggledObjects.set(entity.id, entity);
        }
    };

    Batch.prototype.add = function(updater, instance) {
        var id = updater.entity.id;
        this.createPrimitive = true;
        this.geometry.set(id, instance);
        this.updaters.set(id, updater);
        if (!updater.hasConstantOutline || !updater.outlineColorProperty.isConstant) {
            this.updatersWithAttributes.set(id, updater);
        }
        this.subscriptions.set(id, updater.entity.definitionChanged.addEventListener(Batch.prototype.uiShowChanged, this));
    };

    Batch.prototype.remove = function(updater) {
        var id = updater.entity.id;
        this.createPrimitive = this.geometry.remove(id) || this.createPrimitive;
        this.updaters.remove(id);
        this.updatersWithAttributes.remove(id);
        this.toggledObjects.removeAll();
        var subscription = this.subscriptions.get(id);
        if (defined(subscription)) {
            subscription();
        }
        this.subscriptions.remove(id);
    };

    var colorScratch = new Color();
    Batch.prototype.update = function(time) {
        var show = true;
        var isUpdated = true;
        var removedCount = 0;
        var primitive = this.primitive;
        var primitives = this.primitives;
        if (this.createPrimitive) {
            this.attributes.removeAll();
            if (defined(primitive)) {
                if (primitive.ready) {
                    this.oldPrimitive = primitive;
                } else {
                    primitives.remove(primitive);
                }
                show = false;
            }
            var geometry = this.geometry.values;
            if (geometry.length > 0) {
                primitive = new Primitive({
                    asynchronous : true,
                    geometryInstances : geometry,
                    appearance : new PerInstanceColorAppearance({
                        flat : true,
                        translucent : this.translucent
                    })
                });

                primitives.add(primitive);
                isUpdated = false;
                primitive.show = show;
            }
            this.primitive = primitive;
            this.createPrimitive = false;
        } else if (defined(primitive) && primitive.ready) {
            if (defined(this.oldPrimitive)) {
                primitives.remove(this.oldPrimitive);
                this.oldPrimitive = undefined;
                primitive.show = true;
            }
            var updater;
            var entity;
            var id;
            var attributes;
            var i;

            var updatersWithAttributes = this.updatersWithAttributes.values;
            var length = updatersWithAttributes.length;
            for (i = 0; i < length; i++) {
                updater = updatersWithAttributes[i];
                entity = updater.entity;
                id = entity.id;

                attributes = this.attributes.get(id);
                if (!defined(attributes)) {
                    attributes = primitive.getGeometryInstanceAttributes(entity);
                    this.attributes.set(id, attributes);
                }

                if (!updater.outlineColorProperty.isConstant) {
                    var outlineColorProperty = updater.outlineColorProperty;
                    outlineColorProperty.getValue(time, colorScratch);
                    if (!Color.equals(attributes._lastColor, colorScratch)) {
                        attributes._lastColor = Color.clone(colorScratch, attributes._lastColor);
                        attributes.color = ColorGeometryInstanceAttribute.toValue(colorScratch, attributes.color);
                        if ((this.translucent && attributes.color[3] === 255) || (!this.translucent && attributes.color[3] !== 255)) {
                            this.itemsToRemove[removedCount++] = updater;
                        }
                    }
                }

                if (!updater.hasConstantOutline) {
                    show = updater.isOutlineVisible(time);
                    if (show !== attributes._lastShow) {
                        attributes._lastShow = show;
                        attributes.show = ShowGeometryInstanceAttribute.toValue(show, attributes.show);
                    }
                }
            }

            var updaters = this.updaters;
            var toggledObjects = this.toggledObjects.values;
            length = toggledObjects.length;
            for (i = 0; i < length; i++) {
                entity = toggledObjects[i];
                id = entity.id;
                updater = updaters.get(id);
                attributes = this.attributes.get(id);
                if (!defined(attributes)) {
                    attributes = primitive.getGeometryInstanceAttributes(entity);
                    this.attributes.set(id, attributes);
                }
                var uishow = updater.isOutlineVisible(time) && entity.uiShow;
                if (uishow !== attributes._lastShow) {
                    attributes._lastShow = uishow;
                    attributes.show = ShowGeometryInstanceAttribute.toValue(uishow, attributes.show);
                }
            }
            this.toggledObjects.removeAll();
        } else if (defined(primitive) && !primitive.ready) {
            isUpdated = false;
        }

        this.itemsToRemove.length = removedCount;
        return isUpdated;
    };

    Batch.prototype.removeAllPrimitives = function() {
        var primitive = this.primitive;
        if (defined(primitive)) {
            this.primitives.remove(primitive);
            this.primitive = undefined;
        }

        this.geometry.removeAll();
        this.updaters.removeAll();
        this.updatersWithAttributes.removeAll();
        this.attributes.removeAll();
        this.toggledObjects.removeAll();

        var subscriptions = this.subscriptions.values;
        var len = subscriptions.length;
        for (var i = 0; i < len; i++) {
            subscriptions[i]();
        }
        this.subscriptions.removeAll();
        this.itemsToRemove.length = 0;
    };

    /**
     * @private
     */
    var StaticOutlineGeometryBatch = function(primitives) {
        this._solidBatch = new Batch(primitives, false);
        this._translucentBatch = new Batch(primitives, true);
    };

    StaticOutlineGeometryBatch.prototype.add = function(time, updater) {
        var instance = updater.createOutlineGeometryInstance(time);
        if (instance.attributes.color.value[3] === 255) {
            this._solidBatch.add(updater, instance);
        } else {
            this._translucentBatch.add(updater, instance);
        }
    };

    StaticOutlineGeometryBatch.prototype.remove = function(updater) {
        if (!this._solidBatch.remove(updater)) {
            this._translucentBatch.remove(updater);
        }
    };

    StaticOutlineGeometryBatch.prototype.update = function(time) {
        var i;
        var updater;

        //Perform initial update
        var isUpdated = this._solidBatch.update(time);
        isUpdated = this._translucentBatch.update(time) && isUpdated;

        //If any items swapped between solid/translucent, we need to
        //move them between batches
        var itemsToRemove = this._solidBatch.itemsToRemove;
        var solidsToMoveLength = itemsToRemove.length;
        if (solidsToMoveLength > 0) {
            for (i = 0; i < solidsToMoveLength; i++) {
                updater = itemsToRemove[i];
                this._solidBatch.remove(updater);
                this._translucentBatch.add(updater, updater.createOutlineGeometryInstance(time));
            }
        }

        itemsToRemove = this._translucentBatch.itemsToRemove;
        var translucentToMoveLength = itemsToRemove.length;
        if (translucentToMoveLength > 0) {
            for (i = 0; i < translucentToMoveLength; i++) {
                updater = itemsToRemove[i];
                this._translucentBatch.remove(updater);
                this._solidBatch.add(updater, updater.createOutlineGeometryInstance(time));
            }
        }

        //If we moved anything around, we need to re-build the primitive
        if (solidsToMoveLength > 0 || translucentToMoveLength > 0) {
            isUpdated = this._solidBatch.update(time) && isUpdated;
            isUpdated = this._translucentBatch.update(time) && isUpdated;
        }
        return isUpdated;
    };

    StaticOutlineGeometryBatch.prototype.removeAllPrimitives = function() {
        this._solidBatch.removeAllPrimitives();
        this._translucentBatch.removeAllPrimitives();
    };

    return StaticOutlineGeometryBatch;
});